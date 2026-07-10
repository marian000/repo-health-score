#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../dist/cli.js';

const packageJson = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'package.json',
);
const { version } = JSON.parse(await readFile(packageJson, 'utf8'));

const { exitCode } = await main(process.argv.slice(2), String(version));
process.exitCode = exitCode;
