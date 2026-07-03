// Non-interactive validation of the stage swap logic + status classifier.
// Uses sleep/counter stand-ins instead of real claude. Run: npm run stagetest
import { spawnSync } from 'node:child_process';
import {
  SOCKET,
  DASH_TAG,
  PLACEHOLDER_TAG,
  listPanes,
  setPaneTag,
  swapPane,
  capturePane,
  liveSessions,
  classifyCapture,
} from './tmux.js';

// HARD SAFETY GUARD. This test calls `kill-server`, which tears down the entire
// tmux server on SOCKET — including a live orc dashboard and every session it
// hosts. Refuse to run unless pointed at a throwaway socket via $ORC_SOCKET, so
// it can never nuke the user's real `orc`. `npm run stagetest` sets this.
if (SOCKET === 'orc') {
  console.error(
    'stage-test is destructive (kill-server) and refuses to run on the live "orc" socket.\n' +
      'Run it via `npm run stagetest` (which sets ORC_SOCKET=orc-test), or set ORC_SOCKET yourself.',
  );
  process.exit(1);
}

function raw(args: string[]) {
  return spawnSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
}
function sleep(ms: number) {
  spawnSync('sleep', [String(ms / 1000)]);
}
let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const counter = (tag: string) =>
  `i=0; while true; do echo "${tag} tick $i"; i=$((i+1)); sleep 1; done`;

// clean slate
raw(['kill-server']);
sleep(300);

// dashboard: left (dash) + right (placeholder)
raw(['new-session', '-d', '-s', 'orc', '-x', '120', '-y', '14', 'sleep 100000']);
const left = listPanes().find((p) => p.session === 'orc')!;
setPaneTag(left.paneId, DASH_TAG);
raw(['split-window', '-h', '-t', left.paneId, 'sleep 100000']);
const placeholder = listPanes().find(
  (p) => p.session === 'orc' && p.paneId !== left.paneId,
)!;
setPaneTag(placeholder.paneId, PLACEHOLDER_TAG);

// two background "sessions"
raw(['new-session', '-d', '-s', 'orc-a', counter('A')]);
const aPane = listPanes().find((p) => p.session === 'orc-a')!;
setPaneTag(aPane.paneId, 's|id-aaa|Session A');
raw(['new-session', '-d', '-s', 'orc-b', counter('B')]);
const bPane = listPanes().find((p) => p.session === 'orc-b')!;
setPaneTag(bPane.paneId, 's|id-bbb|Session B');

const dashWindow = left.windowId;
const totalPanes = () => listPanes().length;
const stageText = () => capturePane(listPanes().find((p) => p.windowId === dashWindow && p.paneId !== left.paneId)!.paneId);

console.log('stage swap logic:');
check('4 panes exist at start', totalPanes() === 4);

// one-swap stage model: stagePaneId starts as the placeholder
let stagePaneId = placeholder.paneId;

// show A
swapPane(aPane.paneId, stagePaneId);
stagePaneId = aPane.paneId;
sleep(1800);
check('A is on stage', /A tick/.test(stageText()));
check('pane count conserved after showing A (4)', totalPanes() === 4);

// show B
swapPane(bPane.paneId, stagePaneId);
stagePaneId = bPane.paneId;
sleep(1800);
const dash = stageText();
check('B is on stage', /B tick/.test(dash));
check('A no longer on stage', !/A tick/.test(dash));
check('pane count conserved after switch (4)', totalPanes() === 4);

// A kept running in the background while off-stage
const aLive = liveSessions().find((s) => s.resumeId === 'id-aaa');
check('A still tracked as a live session', !!aLive);
check('A still ticking off-stage', !!aLive && /A tick/.test(capturePane(aLive.paneId)));

// labels / ids recovered from pane titles
const sessions = liveSessions();
check('two live sessions tracked', sessions.length === 2);
check('labels recovered from tags', sessions.some((s) => s.label === 'Session A') && sessions.some((s) => s.label === 'Session B'));

console.log('status classifier:');
// Real bottom-chrome captures (the live status lives only in the last few lines).
const MODE_WORKING = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents';
const MODE_IDLE = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
const inputBox = `${'─'.repeat(80)}\n❯ \n${'─'.repeat(80)}`;
const workingScreen = `✢ Elucidating… (7m 22s · ↓ 14.8k tokens)\n\n${inputBox}\n${MODE_WORKING}`;
const idleScreen = `✻ Crunched for 16m 19s\n\n${inputBox}\n${MODE_IDLE}\n  ⧉  some · context`;
// Real footer carries a leading spinner glyph; the workflow progress line and
// context line sit below the mode line.
const bgWaitScreen = `✻ Waiting for 1 dynamic workflow to finish\n\n${inputBox}\n${MODE_IDLE}\n  ◯ sfp-extra  0/12 agents done · 2m 42s\n  ⧉  a · b`;

check('working mode line -> running', classifyCapture('node', workingScreen) === 'running');
check('idle mode line -> ready', classifyCapture('claude', idleScreen) === 'ready');
check('bg dynamic-workflow wait -> running', classifyCapture('node', bgWaitScreen) === 'running');
check(
  'bg agents+workflow wait -> running',
  classifyCapture('node', `✻ Waiting for 2 background agents and 1 dynamic workflow to finish\n\n${inputBox}\n${MODE_IDLE}\n  ⧉  a · b`) === 'running',
);
check('shell command -> dead', classifyCapture('zsh', 'denton@host $ ') === 'dead');

// Regression: the markers appearing in the CONVERSATION body must NOT trip the
// classifier. A chat *about* orc's own status detection is full of these phrases
// (this very session was). Only the bottom chrome counts, and it's idle here.
const metaChatIdle =
  'You said it shows "esc to interrupt" and "Waiting for 1 dynamic workflow to finish".\n' +
  'I hardened the markers (dynamic workflow to finish / background agents to finish).\n' +
  `${'─'.repeat(80)}\n❯ \n${'─'.repeat(80)}\n${MODE_IDLE}\n  ⧉  orc · context`;
check('marker phrases in transcript body -> still ready', classifyCapture('claude', metaChatIdle) === 'ready');

raw(['kill-server']);
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
