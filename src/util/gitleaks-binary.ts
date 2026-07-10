import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from './exec.js';

/**
 * Gitleaks is a Go binary, not an npm package, so `npx repo-health-score .`
 * cannot install it as a dependency. It is fetched on first run and cached.
 *
 * The version is pinned rather than resolved to "latest" for two reasons:
 * a moving scanner makes scores irreproducible across runs, and "latest"
 * cannot be checksum-verified ahead of time.
 */
export const GITLEAKS_VERSION = '8.30.1';

/**
 * SHA-256 of each release archive, copied from the signed checksums file of
 * the pinned release.
 *
 * These are the whole security model of this module. Downloading the
 * checksums file alongside the binary would verify nothing: whoever can serve
 * a malicious binary can serve a matching checksum. Pinning the digest in the
 * repository means a compromised release, a hijacked CDN, or a
 * man-in-the-middle all fail closed — this tool runs the downloaded binary,
 * so a swapped archive is arbitrary code execution on the user's machine and
 * in their CI.
 *
 * Bump the version and these digests together, from
 * https://github.com/gitleaks/gitleaks/releases/download/v<version>/gitleaks_<version>_checksums.txt
 */
const CHECKSUMS: Readonly<Record<string, string>> = {
  'darwin-arm64':
    'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
  'darwin-x64':
    'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
  'linux-arm64':
    'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
  'linux-x64':
    '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
  'win32-x64':
    'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e',
};

const DOWNLOAD_TIMEOUT_MS = 120_000;

export class UnsupportedPlatformError extends Error {
  constructor(platform: string) {
    super(`No pinned Gitleaks build for ${platform}`);
    this.name = 'UnsupportedPlatformError';
  }
}

export class ChecksumMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Gitleaks archive failed checksum verification.\n` +
        `  expected ${expected}\n  actual   ${actual}\n` +
        `Refusing to execute it. This means the download was corrupted or tampered with.`,
    );
    this.name = 'ChecksumMismatchError';
  }
}

/**
 * Resolve a Gitleaks binary, downloading and verifying it if absent.
 *
 * An explicit `REPO_HEALTH_GITLEAKS_PATH` wins, for air-gapped CI that
 * pre-installs the binary. Otherwise the pinned build is used even when some
 * other `gitleaks` sits on PATH: a different version applies different rules
 * and would silently change the score between machines.
 */
export async function resolveGitleaks(): Promise<string> {
  const override = process.env['REPO_HEALTH_GITLEAKS_PATH'];
  if (override !== undefined && override !== '') return override;

  const key = platformKey();
  const expected = CHECKSUMS[key];
  if (expected === undefined) throw new UnsupportedPlatformError(key);

  const binaryName = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks';
  const installDir = join(cacheRoot(), 'gitleaks', GITLEAKS_VERSION);
  const binaryPath = join(installDir, binaryName);
  const stampPath = join(installDir, '.archive-sha256');

  // Trusting a cached binary because it exists would make the pinned digest
  // guard only the first download. Anything that can write to the cache — a
  // malicious postinstall, a poisoned CI cache artifact, an interrupted
  // extraction — would then be executed on every later scan, forever. The
  // stamp records the digest of the archive this binary came from, and the
  // binary's own digest proves it has not been swapped since.
  if (await isVerifiedInstall(binaryPath, stampPath, expected)) {
    return binaryPath;
  }

  await rm(installDir, { recursive: true, force: true });
  await downloadAndInstall(key, expected, installDir, binaryName, stampPath);
  await chmod(binaryPath, 0o755);

  return binaryPath;
}

/** The cache is valid only if the stamp matches the pinned digest *and* the recorded binary digest still holds. */
async function isVerifiedInstall(
  binaryPath: string,
  stampPath: string,
  expectedArchive: string,
): Promise<boolean> {
  let stamp: string;
  try {
    stamp = await readFile(stampPath, 'utf8');
  } catch {
    return false;
  }

  const [archiveDigest, binaryDigest] = stamp.trim().split('\n');
  if (archiveDigest !== expectedArchive || binaryDigest === undefined) {
    return false;
  }

  const actual = await hashFile(binaryPath);
  return actual === binaryDigest;
}

async function downloadAndInstall(
  key: string,
  expectedChecksum: string,
  installDir: string,
  binaryName: string,
  stampPath: string,
): Promise<void> {
  const archiveName = archiveNameFor(key);
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archiveName}`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download Gitleaks: ${String(response.status)} ${response.statusText} (${url})`,
    );
  }

  const archive = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(archive).digest('hex');

  // Verify before anything touches the archive. Extracting an untrusted
  // tarball is itself an attack surface — path traversal, symlink escape — so
  // the check comes before extraction, not merely before execution.
  if (actual !== expectedChecksum) {
    throw new ChecksumMismatchError(expectedChecksum, actual);
  }

  // Extract into a staging directory and move the finished tree into place, so
  // a killed process or a concurrent scan can never leave a half-written
  // binary that a later run would go on to trust.
  //
  // Staged inside the cache root, not the system temp dir: `rename` is only
  // atomic within one filesystem, and on Linux /tmp is routinely a separate
  // tmpfs, which would fail with EXDEV.
  await mkdir(dirname(installDir), { recursive: true });
  const staging = await mkdtemp(`${installDir}.staging-`);
  try {
    const archivePath = join(staging, archiveName);
    await writeFile(archivePath, archive);
    await extract(archivePath, staging);

    const stagedBinary = join(staging, binaryName);
    const binaryDigest = await hashFile(stagedBinary);
    await writeFile(
      join(staging, '.archive-sha256'),
      `${expectedChecksum}\n${binaryDigest}\n`,
    );
    await rm(archivePath, { force: true });

    await rename(staging, installDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    // A concurrent scan that finished first already installed a verified
    // binary; losing that race is success, not failure.
    if (isAlreadyInstalled(error) && (await exists(stampPath))) return;
    throw error;
  }

  if (!(await exists(stampPath))) {
    throw new Error('Gitleaks install completed without writing its stamp');
  }
}

/**
 * `tar` handles both formats and ships with Windows 10+, so there is no need to
 * hand a constructed script to `powershell -Command` — which would reintroduce
 * exactly the shell injection that `run()` exists to prevent, via a cache path
 * the user controls through XDG_CACHE_HOME.
 */
async function extract(
  archivePath: string,
  destination: string,
): Promise<void> {
  await run('tar', ['-xf', archivePath, '-C', destination], {
    cwd: destination,
    timeoutMs: 60_000,
  });
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/** `rename` onto a path another process just created. */
function isAlreadyInstalled(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM';
}

/** Release assets use Go's arch names, which differ from Node's on 64-bit x86. */
function archiveNameFor(key: string): string {
  const [platform = '', arch = ''] = key.split('-');
  const suffix = platform === 'win32' ? 'zip' : 'tar.gz';
  const goPlatform = platform === 'win32' ? 'windows' : platform;
  return `gitleaks_${GITLEAKS_VERSION}_${goPlatform}_${arch}.${suffix}`;
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function cacheRoot(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  const base =
    xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.cache');
  return join(base, 'repo-health-score');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
