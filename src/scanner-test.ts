// Non-interactive validation of transcript parsing + the hidden-row rule.
// Fixture .jsonl files in a temp dir; no tmux, no network, nothing read from
// ~/.claude. Run: npm run scannertest
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, isHidden, HIDE_HEADLESS_TURNS, type Session } from './scanner.js';

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}
let checks = 0;
const assert = (label: string, ok: boolean) => {
  checks++;
  check(label, ok);
};

const dir = mkdtempSync(join(tmpdir(), 'orc-scanner-'));

// --- fixture builders -------------------------------------------------------
// Shaped like real Claude Code records: every user/assistant line carries
// cwd + entrypoint, a user prompt's text lives in message.content.
let clock = Date.parse('2026-09-11T09:00:00Z');
const stamp = () => new Date((clock += 60_000)).toISOString();

type Rec = Record<string, unknown>;
function userRec(text: string, entrypoint: string | null, cwd: string): Rec {
  const r: Rec = {
    type: 'user',
    uuid: `u-${clock}`,
    cwd,
    timestamp: stamp(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
  if (entrypoint !== null) r.entrypoint = entrypoint;
  return r;
}
function assistantRec(entrypoint: string | null, cwd: string): Rec {
  const r: Rec = {
    type: 'assistant',
    uuid: `a-${clock}`,
    cwd,
    timestamp: stamp(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  };
  if (entrypoint !== null) r.entrypoint = entrypoint;
  return r;
}

/** Write a transcript of `turns` records (alternating user/assistant) and
 *  parse it back the way scanSessions would. */
function fixture(
  id: string,
  opts: { entrypoint: string | null; turns: number; firstPrompt?: string; cwd?: string },
): Session {
  const cwd = opts.cwd ?? '/home/denton/projects/orc';
  const recs: Rec[] = [];
  for (let i = 0; i < opts.turns; i++) {
    recs.push(
      i % 2 === 0
        ? userRec(i === 0 ? (opts.firstPrompt ?? 'fix the failing test') : 'and now this', opts.entrypoint, cwd)
        : assistantRec(opts.entrypoint, cwd),
    );
  }
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return parseFile(path, Date.now());
}

const DIGEST_PROMPT =
  '<command-message>morning-digest</command-message>\n<command-name>/morning-digest</command-name>';

// --- parse ------------------------------------------------------------------
console.log('parseFile reads the new fields:');

const interactive = fixture('interactive', { entrypoint: 'cli', turns: 8 });
assert("cli session -> entrypoint 'cli'", interactive.entrypoint === 'cli');
assert('cli session -> 8 turns', interactive.turns === 8);
assert('cli session -> not slash-titled', interactive.slashTitled === false);

const probe = fixture('probe', { entrypoint: 'sdk-cli', turns: 6 });
assert("claude -p probe -> entrypoint 'sdk-cli'", probe.entrypoint === 'sdk-cli');
assert('claude -p probe -> 6 turns', probe.turns === 6);
assert('claude -p probe -> not slash-titled', probe.slashTitled === false);

const digest = fixture('digest', { entrypoint: 'sdk-cli', turns: 6, firstPrompt: DIGEST_PROMPT });
assert("scheduled digest -> entrypoint 'sdk-cli'", digest.entrypoint === 'sdk-cli');
assert('scheduled digest -> slash-titled', digest.slashTitled === true);
assert('scheduled digest keeps its dated title', /^morning-digest \d{4}-\d{2}-\d{2}$/.test(digest.title));

const noField = fixture('no-entrypoint', { entrypoint: null, turns: 4 });
assert("no entrypoint field anywhere -> ''", noField.entrypoint === '');
assert('no entrypoint field -> turns still counted', noField.turns === 4);

// Sidechain (sub-agent) turns count toward the total — see parseFile.
{
  const path = join(dir, 'sidechain.jsonl');
  writeFileSync(
    path,
    [
      JSON.stringify(userRec('go', 'cli', '/home/denton')),
      JSON.stringify({ ...assistantRec('cli', '/home/denton'), isSidechain: true }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'something' }),
    ].join('\n') + '\n',
  );
  assert('sidechain turns counted, metadata records not', parseFile(path, Date.now()).turns === 2);
}

// An explicit empty `entrypoint` on the first record that carries the field
// still wins: a later record must not overwrite it (first-wins is about which
// record spoke first, not about which value is truthy).
{
  const path = join(dir, 'empty-entrypoint-first.jsonl');
  writeFileSync(
    path,
    [
      JSON.stringify(userRec('go', '', '/home/denton')),
      JSON.stringify(assistantRec('sdk-cli', '/home/denton')),
    ].join('\n') + '\n',
  );
  assert("first record's empty entrypoint is not overwritten", parseFile(path, Date.now()).entrypoint === '');
}

// --- isHidden ---------------------------------------------------------------
console.log('isHidden rule:');
const NO_NAMES: Record<string, string> = {};

assert('sdk-cli probe -> hidden', isHidden(probe, NO_NAMES) === true);
assert('sdk-cli slash-titled -> shown', isHidden(digest, NO_NAMES) === false);
assert('a saved name beats the rule', isHidden(probe, { [probe.id]: 'keep me' }) === false);
assert('an empty saved name does not', isHidden(probe, { [probe.id]: '' }) === true);
assert('cli session -> shown', isHidden(interactive, NO_NAMES) === false);
assert("no entrypoint field -> shown", isHidden(noField, NO_NAMES) === false);

// The turn threshold. The spec fixes the value, so pin the literal — deriving
// the fixtures from the constant would only pin "the boundary is exclusive".
assert('HIDE_HEADLESS_TURNS is 20', HIDE_HEADLESS_TURNS === 20);
const long = fixture('long-probe', { entrypoint: 'sdk-cli', turns: 20 });
const short = fixture('short-probe', { entrypoint: 'sdk-cli', turns: 19 });
assert('sdk-cli with 20 turns -> shown', isHidden(long, NO_NAMES) === false);
assert('sdk-cli with 19 turns -> hidden', isHidden(short, NO_NAMES) === true);

// Scratchpad cwds are throwaway whatever launched them.
const scratch = fixture('scratch', {
  entrypoint: 'cli',
  turns: 40,
  cwd: '/tmp/claude-1000/x/scratchpad',
});
assert('cli session in a /tmp/claude- scratchpad -> hidden', isHidden(scratch, NO_NAMES) === true);
assert('…unless it has a saved name', isHidden(scratch, { [scratch.id]: 'mine' }) === false);
const nearMiss = fixture('near-miss', { entrypoint: 'cli', turns: 4, cwd: '/tmp/claude' });
assert("cwd '/tmp/claude' (no dash) -> shown", isHidden(nearMiss, NO_NAMES) === false);
// The prefix has to be at the start: a cwd that merely contains it is real work.
const midPath = fixture('mid-path', {
  entrypoint: 'cli',
  turns: 4,
  cwd: '/home/denton/tmp/claude-x',
});
assert("'/tmp/claude-' mid-path, not at the start -> shown", isHidden(midPath, NO_NAMES) === false);

rmSync(dir, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} FAILURE(S) of ${checks} checks`);
  process.exit(1);
}
console.log(`\nOK ${checks} checks`);
