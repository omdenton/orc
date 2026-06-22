import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Persistent custom names for sessions, keyed by claude session id.
const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'orc');
const file = join(dir, 'names.json');

let cache: Record<string, string> | null = null;

export function loadNames(): Record<string, string> {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    cache = {};
  }
  return cache!;
}

export function setName(id: string, name: string): void {
  const names = loadNames();
  const trimmed = name.trim();
  if (trimmed) names[id] = trimmed;
  else delete names[id]; // empty name clears the override
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(names, null, 2));
  } catch {
    /* best-effort; in-memory cache still applies for this run */
  }
}
