import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Persistent custom names for sessions, keyed by claude session id.
const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'orc');
const file = join(dir, 'names.json');

let cache: Record<string, string> | null = null;
let cacheMtime = -1;

// Re-read names.json whenever its mtime changes so external writers (e.g. a
// skill that names its own session before orc ever saw it) show up live,
// without re-parsing on every poll when nothing changed.
export function loadNames(): Record<string, string> {
  try {
    const m = statSync(file).mtimeMs;
    if (cache && m === cacheMtime) return cache;
    cache = JSON.parse(readFileSync(file, 'utf8'));
    cacheMtime = m;
  } catch {
    if (!cache) cache = {};
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
    // Keep the mtime marker in step with our own write so loadNames() doesn't
    // treat it as an external change and re-read the file we just produced.
    cacheMtime = statSync(file).mtimeMs;
  } catch {
    /* best-effort; in-memory cache still applies for this run */
  }
}
