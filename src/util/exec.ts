import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 30s is generous for `composer audit` on a large lockfile and short enough to not hang CI. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Scanners on huge repos can emit a lot of JSON; 64 MB is well past any realistic report. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Non-zero is normal for audit tools: `npm audit` exits 1 when it finds vulnerabilities. */
  readonly exitCode: number;
}

export interface ExecOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Extra environment on top of the parent process's. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Raised when the executable itself is missing from PATH.
 *
 * This is the single most important distinction in the whole module layer: a
 * missing tool is an expected condition that must become a not-applicable
 * result, while a tool that ran and failed is a real error worth surfacing.
 * Conflating them either crashes on a machine without Composer, or silently
 * swallows a genuine scanner bug.
 */
export class CommandNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`Command not found: ${command}`);
    this.name = 'CommandNotFoundError';
  }
}

export class CommandTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`Command timed out after ${timeoutMs}ms: ${command}`);
    this.name = 'CommandTimeoutError';
  }
}

/**
 * Run a command and capture its output.
 *
 * Uses `execFile`, never `exec`: arguments are passed as an array and never go
 * through a shell, so a repository path containing `;` or `$(...)` cannot
 * inject a command. This matters because `repoRoot` is attacker-controlled in
 * the CI case — a malicious repo names a directory and we run scanners in it.
 *
 * A non-zero exit code is returned, not thrown. Audit tools use exit codes to
 * signal findings rather than failure.
 *
 * @throws {CommandNotFoundError} if the executable is not on PATH.
 * @throws {CommandTimeoutError} if it exceeds the timeout.
 */
export async function run(
  command: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: 'utf8',
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = asExecFailure(error);

    if (failure.code === 'ENOENT') {
      throw new CommandNotFoundError(command);
    }
    // Node reports a timeout kill as a signal, not an error code.
    if (failure.killed === true || failure.signal === 'SIGTERM') {
      throw new CommandTimeoutError(command, timeoutMs);
    }
    if (typeof failure.code === 'number') {
      return {
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
        exitCode: failure.code,
      };
    }
    throw error;
  }
}

interface ExecFailure {
  code?: number | string;
  killed?: boolean;
  signal?: string;
  stdout?: string;
  stderr?: string;
}

/** Every field of ExecFailure is optional, so any object narrows to it without an assertion. */
function asExecFailure(error: unknown): ExecFailure {
  return typeof error === 'object' && error !== null ? error : {};
}
