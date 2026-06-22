#!/usr/bin/env node
// Thin launcher: runs the TS entrypoint through tsx (no build step).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const entry = join(root, 'src', 'index.tsx');

// Prefer the locally-installed tsx binary; fall back to npx.
const localTsx = join(root, 'node_modules', '.bin', 'tsx');
const cmd = existsSync(localTsx) ? localTsx : 'npx';
const passthrough = process.argv.slice(2); // forward e.g. __pane / __placeholder
const args = existsSync(localTsx) ? [entry, ...passthrough] : ['tsx', entry, ...passthrough];

const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: process.cwd() });
process.exit(r.status ?? 0);
