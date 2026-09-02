import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useInput, useStdout } from 'ink';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as tmux from './tmux.js';
import { scanSessions, canAdopt, collapseForks, attentionMs, type Session } from './scanner.js';
import { loadNames, setName } from './names.js';

const ORC_BIN = fileURLToPath(new URL('../bin/orc.mjs', import.meta.url));
const NODE = process.execPath;
const HOME = homedir();
const POLL_MS = 1500;

const paneCmd = (sub: string) => `${tmux.shellQuote(NODE)} ${tmux.shellQuote(ORC_BIN)} ${sub}`;

// ===========================================================================
// Bootstrap: create the dashboard tmux session (left = orc UI, right = stage),
// then attach. Re-running orc just reattaches.
// ===========================================================================
function createDashboard() {
  const cols = process.stdout.columns ?? 200;
  const rows = process.stdout.rows ?? 50;

  tmux.newDashboard(cols, rows, paneCmd('__pane'));
  const left = tmux.listPanes().find((p) => p.session === tmux.DASH_SESSION);
  if (!left) {
    console.error('orc: failed to create dashboard pane.');
    process.exit(1);
  }
  tmux.setPaneTag(left.paneId, tmux.DASH_TAG);
  // Keep the pane if the UI crashes, so a re-run can respawn it (see bootstrap).
  tmux.setPaneOption(left.paneId, 'remain-on-exit', 'on');

  tmux.splitRight(left.paneId, paneCmd('__placeholder'));
  const ph = tmux
    .listPanes()
    .find((p) => p.session === tmux.DASH_SESSION && p.paneId !== left.paneId);
  if (ph) tmux.setPaneTag(ph.paneId, tmux.PLACEHOLDER_TAG);

  // Pin the sidebar to its share of the terminal, and re-pin it whenever the
  // client resizes or attaches, so it holds that proportion instead of a fixed
  // column count that reads as a sliver on a wide screen and half the window on
  // a narrow one.
  tmux.pinSidebar(left.paneId, tmux.SIDEBAR_RATIO, cols);

  // cosmetics + focus keys (scoped to the orc socket, so your normal tmux is untouched)
  tmux.setGlobalOption('status', 'off');
  tmux.setGlobalOption('mouse', 'on');
  tmux.setGlobalOption('pane-border-status', 'off');
  // Mouse mode (above) lets you drag the pane divider, but it also makes tmux
  // swallow drag-selections into copy mode — they'd just vanish on release.
  // So: pipe a mouse-drag selection straight to the Wayland clipboard and exit
  // copy mode, so a plain drag actually copies. (Shift+drag still bypasses tmux
  // entirely for native Alacritty selection / link-clicking.) set-clipboard on
  // also lets the hosted claude sessions write your clipboard via OSC52.
  tmux.setGlobalOption('set-clipboard', 'on');
  tmux.bindKeyInTable('copy-mode-vi', 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-pipe-and-cancel', 'wl-copy');
  tmux.bindKeyInTable('copy-mode', 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-pipe-and-cancel', 'wl-copy');
  tmux.bindRootKey('M-h', 'select-pane', '-L');
  tmux.bindRootKey('M-l', 'select-pane', '-R');
  tmux.bindRootKey('M-Left', 'select-pane', '-L');
  tmux.bindRootKey('M-Right', 'select-pane', '-R');
  // orc inherits the user's ~/.tmux.conf, which may bind Alt-Up/Down (e.g. to
  // switch-client) — easy to hit by accident while picking a row, and it yanks
  // the client off the dashboard. This layout is two side-by-side panes, so
  // vertical pane moves are meaningless; drop them so they're inert.
  tmux.unbindRootKey('M-Up');
  tmux.unbindRootKey('M-Down');
  // Same story for the Enter splits: terminals send Shift/Ctrl-Enter as an
  // ESC-prefixed CR (that's what `claude /terminal-setup` configures), which
  // tmux reads as M-Enter and splits on — so a newline in claude's composer
  // spawns a pane instead. Splits are meaningless here anyway; drop them so
  // the key falls through to the hosted session.
  tmux.unbindRootKey('M-Enter');
  tmux.unbindRootKey('M-S-Enter');

  tmux.selectPane(left.paneId);
}

function bootstrap() {
  if (!tmux.tmuxAvailable()) {
    console.error('orc requires tmux. Install it and try again.');
    process.exit(1);
  }

  if (!tmux.hasSession(tmux.DASH_SESSION)) {
    createDashboard();
  } else {
    // A dashboard exists — make sure its UI pane is healthy before attaching.
    const dash = tmux.listPanes().find((p) => p.tag === tmux.DASH_TAG);
    if (!dash) {
      // Layout is gone (severe crash). Rebuild fresh; sessions are resumable from history.
      tmux.killServer();
      createDashboard();
    } else if (dash.dead || dash.cmd !== 'node') {
      // UI crashed but the hosted sessions are intact — restart just the UI pane.
      tmux.respawnPane(dash.paneId, paneCmd('__pane'));
      tmux.setPaneOption(dash.paneId, 'remain-on-exit', 'on');
    }
    // The stage slot may have collapsed (the staged claude exited, closing its
    // pane and its half of the window). Restore the two-pane layout before
    // attaching, so the user isn't left with a full-width sidebar: rejoin the
    // existing placeholder if one is parked in a background window (it gets
    // swapped out there whenever a session is staged), else split a fresh one.
    // The sidebar width re-pins via the client-attached hook.
    if (dash) {
      const stage = tmux
        .listPanes()
        .find((p) => p.windowId === dash.windowId && p.paneId !== dash.paneId);
      if (!stage) {
        const parked = tmux.paneByTag(tmux.PLACEHOLDER_TAG);
        if (parked) {
          tmux.joinPaneRight(parked.paneId, dash.paneId);
        } else {
          tmux.splitRight(dash.paneId, paneCmd('__placeholder'));
          const ph = tmux
            .listPanes()
            .find((p) => p.windowId === dash.windowId && p.paneId !== dash.paneId);
          if (ph) tmux.setPaneTag(ph.paneId, tmux.PLACEHOLDER_TAG);
        }
        tmux.selectPane(dash.paneId);
      }
      // Re-pin proportionally. A dashboard from an older orc (or one whose
      // ratio was never stored) has a fixed-column pin — carry its current
      // proportion over rather than resetting the width the user tuned, then
      // let the client-attached hook apply it at the incoming terminal size.
      const stored = Number(tmux.getGlobalOption(tmux.RATIO_OPT));
      let ratio = stored > 0.05 && stored < 0.9 ? stored : 0;
      if (!ratio) {
        const [pw, ww] = tmux
          .displayFor(dash.paneId, '#{pane_width} #{window_width}')
          .split(' ')
          .map(Number);
        ratio = pw > 0 && ww > 0 ? pw / ww : tmux.SIDEBAR_RATIO;
      }
      tmux.pinSidebar(dash.paneId, ratio, tmux.clientWidth() || process.stdout.columns || 0);
    }
  }

  const code = tmux.attachBlocking();
  process.exit(code);
}

// ===========================================================================
// Placeholder: shown on the stage when no session is selected.
// ===========================================================================
function placeholder() {
  const draw = () => {
    const rows = process.stdout.rows ?? 20;
    const body = [
      '◂ pick a session on the left,',
      '  then press Enter to bring it here.',
      '',
      'sessions keep running even while off-screen.',
      '',
      'Alt-←/→ move focus between list and session.',
    ];
    process.stdout.write('\x1b[2J\x1b[H');
    const top = Math.max(0, Math.floor(rows / 2) - body.length);
    process.stdout.write('\n'.repeat(top) + body.map((l) => '   ' + l).join('\n'));
  };
  draw();
  process.stdout.on('resize', draw);
  process.stdin.resume();
  process.on('SIGTERM', () => process.exit(0));
}

// ===========================================================================
// Dashboard UI (runs in the left pane)
// ===========================================================================
// 'external' = a transcript being written by a claude process OUTSIDE orc
// (another terminal/IDE) — live elsewhere, unsafe to resume in place.
type RowStatus = tmux.Status | 'idle' | 'external';

interface Row {
  key: string;
  title: string;
  cwd: string;
  status: RowStatus;
  /** sort key: when this session last wanted my attention (see attentionMs).
   *  Brand-new sessions with no transcript yet fall back to "now" so they
   *  surface at the top. */
  attention: number;
  live?: tmux.LiveSession;
  historical?: Session;
}

// Is this transcript's claude actively in a turn right now? Content-PROOF: it
// reads the .jsonl, never the screen, so a chat that merely *talks about* "esc
// to interrupt" / "to finish" can't fool it. Two complementary signals, because
// the transcript is written in bursts (one write at turn start, one flush at
// turn end) and stays static mid-stream:
//   - mtime advanced since the last poll → a fresh write (turn boundary or a
//     tool/sub-agent burst). A short grace keeps it flagged across poll gaps.
//   - awaiting a reply (last turn is an unanswered user message) AND written
//     recently → covers the long silent stretch while a response generates.
//     The recency gate is essential: ~13% of dormant sessions end on a bare
//     user turn (measured), and without it they'd false-flag forever.
const ACTIVE_GRACE_MS = 6000;
const BUSY_WINDOW_MS = 60_000;
const lastMtime = new Map<string, number>();
const hotUntil = new Map<string, number>();

function transcriptBusy(id: string, mtimeMs: number, awaitingReply: boolean): boolean {
  const prev = lastMtime.get(id);
  lastMtime.set(id, mtimeMs);
  if (prev !== undefined && mtimeMs > prev) hotUntil.set(id, Date.now() + ACTIVE_GRACE_MS);
  const advancing = (hotUntil.get(id) ?? 0) > Date.now();
  const midTurn = awaitingReply && Date.now() - mtimeMs < BUSY_WINDOW_MS;
  return advancing || midTurn;
}

// A hosted session's effective status. The transcript is the content-proof
// signal that a turn is in flight (active generation, tool calls, sub-agents);
// the screen capture (classifyCapture) is the only thing that can see the
// background-workflow *wait*, where the main transcript goes quiet. Either ⇒
// running. We never DOWNgrade a capture "running" — a dead read still wins.
function liveStatus(captureStatus: tmux.Status, h?: Session): tmux.Status {
  if (captureStatus === 'dead') return 'dead';
  if (h && transcriptBusy(h.id, h.mtimeMs, h.awaitingReply)) return 'running';
  return captureStatus;
}

/** Statuses where the session is working, not waiting on me. */
const busy = (status: RowStatus): boolean => status === 'running' || status === 'external';

// Row-key renames from the last buildRows pass (old key → new key), written
// whenever a row's identity is re-pinned: a fork rebinding a live row, or a
// brand-new pane adopting the transcript it just wrote (paneId → transcript
// id). The Dashboard applies these to its selection (and an in-flight rename
// target) right after each refresh, so the highlight rides across the rebind
// instead of snapping to the top.
const keyAliases = new Map<string, string>();

function buildRows(): Row[] {
  const live = tmux.liveSessions();
  const history = scanSessions(); // newest mtime first
  // `--resume` forks a new transcript file (see Session.firstUuid); collapse
  // each conversation to its newest file so ancestors don't render as
  // duplicate rows, and so live panes can follow their transcript forward.
  const { sessions: current, canonical } = collapseForks(history);
  const names = loadNames();
  keyAliases.clear();

  // Transcript ids already represented by a live row — so they don't also show
  // up as a duplicate idle row below. Resolve every resumed pane's transcript
  // up front (before the render loop and before new-pane adoption): follow the
  // pane's resumeId to the conversation's newest fork, first-come wins if two
  // panes somehow land on the same conversation (the loser keeps its own file).
  const claimed = new Set<string>();
  const binding = new Map<string, Session | undefined>(); // paneId → transcript
  // Bind live panes before dead ones: a remain-on-exit corpse referencing the
  // same conversation (e.g. a duplicate row opened pre-collapse, since exited)
  // must not steal the head transcript from the pane actually writing it.
  const ordered = [...live].sort(
    (a, b) => Number(a.status === 'dead') - Number(b.status === 'dead'),
  );
  for (const l of ordered) {
    if (l.resumeId === 'new') continue;
    const head = canonical.get(l.resumeId);
    const h =
      head && !claimed.has(head.id)
        ? head
        : history.find((x) => x.id === l.resumeId && !claimed.has(x.id));
    if (h) {
      claimed.add(h.id);
      if (h.id !== l.resumeId) {
        // The transcript forked under this pane. Carry a saved rename onto the
        // fork, re-pin the tag so the pane (and a dead-restart) resumes the
        // NEW file — resuming the stale ancestor would drop the recent turns —
        // and record the key change for the selection.
        if (names[l.resumeId] && !names[h.id]) {
          setName(h.id, names[l.resumeId]);
          names[h.id] = names[l.resumeId];
        }
        tmux.setPaneTag(l.paneId, `s|${h.id}|${(names[h.id] ?? l.label ?? h.title).slice(0, 40)}`);
        keyAliases.set(l.resumeId, h.id);
      }
    }
    binding.set(l.paneId, h);
  }

  const rows: Row[] = [];
  for (const l of live) {
    if (l.resumeId !== 'new') {
      const h = binding.get(l.paneId);
      // Unbound pane whose transcript another pane owns → key by pane id so
      // two rows can never collide on the same transcript key.
      const key = h?.id ?? (claimed.has(l.resumeId) ? l.paneId : l.resumeId);
      const status = liveStatus(l.status, h);
      rows.push({
        // Row identity keys off the transcript id, not the pane id: it stays
        // the same across idle → live → idle transitions, so the selection
        // (and a rename in progress) can't silently retarget another session.
        key,
        title: names[key] ?? h?.title ?? l.label ?? '(new session)',
        cwd: l.cwd,
        status,
        attention: attentionMs(h, busy(status)) || Date.now(),
        live: l,
        historical: h,
      });
      continue;
    }
    // Brand-new session: no resume id yet, so find the transcript this pane
    // wrote itself (it appears once the user sends a first message). Until then
    // it's just "new session".
    //
    // Panes we started know their transcript's name up front (createSession
    // hands claude a `--session-id`), so this is an exact id match — no timing
    // guess, and any number of new panes can share a cwd.
    //
    // Panes predating @orc_sid fall back to the old heuristic: a transcript in
    // the same cwd whose first turn happened at/after the pane was born (see
    // canAdopt for why mtime alone isn't enough). That test can't tell two
    // sid-less panes in one cwd apart, so it stays deferred while rivals exist
    // — those panes stall on "new session" until restarted, which is why the
    // pre-assigned id replaced it.
    const legacyRivals = live.filter((x) => x.resumeId === 'new' && !x.sid && x.cwd === l.cwd).length;
    const h = l.sid
      ? current.find((x) => x.id === l.sid && !claimed.has(x.id))
      : legacyRivals === 1
        ? current.find((x) => x.cwd === l.cwd && !claimed.has(x.id) && canAdopt(x, l.born))
        : undefined;
    // A rename of a not-yet-adopted session lives only in the tag label.
    const customLabel = l.label && l.label !== 'new session' ? l.label : '';
    if (h) {
      claimed.add(h.id);
      // Pin the identity to the real transcript id so subsequent polls take the
      // stable resumeId path and this binding can never flip again. Keep a
      // user-chosen label over the transcript's derived title.
      const pinned = (names[h.id] ?? (customLabel || h.title)).slice(0, 40);
      tmux.setPaneTag(l.paneId, `s|${h.id}|${pinned}`);
      // The row was keyed by pane id while it had no transcript; adoption flips
      // the key to the transcript id. Record it, or the highlight (and a rename
      // in progress) loses its target the moment the first message lands.
      keyAliases.set(l.paneId, h.id);
    }
    const title =
      (h && names[h.id]) ||
      customLabel ||
      (h && h.title && h.title !== '(untitled)' ? shortLabel(h.title) : '') ||
      'new session';
    const status = liveStatus(l.status, h);
    rows.push({
      key: h?.id ?? l.paneId,
      title,
      cwd: l.cwd,
      status,
      attention: attentionMs(h, busy(status)) || Date.now(),
      live: l,
      historical: h,
    });
  }
  for (const h of current) {
    if (claimed.has(h.id)) continue;
    rows.push({
      key: h.id,
      title: names[h.id] ?? h.title,
      cwd: h.cwd,
      // Unowned but being written by a claude outside orc → not safe to resume.
      status: transcriptBusy(h.id, h.mtimeMs, h.awaitingReply) ? 'external' : 'idle',
      attention: attentionMs(h, false),
      historical: h,
    });
  }

  // Ordered by whoever wants me most recently: the session I last typed in, or
  // one that has gone quiet waiting on me (see attentionMs). Deliberately NOT
  // raw activity — a background session churning through a long task would
  // otherwise sit permanently above the conversation I'm actually having, and
  // never move. Brand-new sessions sort by Date.now() (set above) so they
  // surface at the top until their first turn.
  rows.sort((a, b) => b.attention - a.attention);
  return rows;
}

function shortPath(p: string): string {
  if (!p) return '';
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
}

// Condense a first-prompt into a short, label-like name for the sidebar.
function shortLabel(s: string): string {
  const clean = (s || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean); // code points — don't bisect emoji
  if (chars.length <= 40) return clean;
  const slice = chars.slice(0, 40).join('');
  const sp = slice.lastIndexOf(' ');
  return (sp >= 20 ? slice.slice(0, sp) : slice).trim();
}

// Keys shown in the `?` overlay. Kept here so the help and the bindings in
// useInput stay in one place.
const SHORTCUTS: [string, string][] = [
  ['↑↓ / j k', 'move up and down'],
  ['Enter', 'open (starts idle sessions) + focus'],
  ['Tab', 'jump focus into the session'],
  ['n', 'name / rename the highlighted chat'],
  ['N', 'new session'],
  ['x', 'kill the highlighted session'],
  ['[  ]', 'shrink / grow the sidebar'],
  ['/', 'filter the list'],
  ['r', 'refresh now'],
  ['d', 'detach — leave sessions running'],
  ['q / Ctrl-C', 'quit orc + tear everything down'],
  ['Alt-← / →', 'move focus: list ⇄ session'],
  ['?', 'toggle this help  ·  Esc closes'],
];

function HelpOverlay({ width }: { width: number }) {
  const keyW = Math.max(...SHORTCUTS.map(([k]) => k.length));
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginTop={1}
      width={width}
    >
      <Box marginBottom={1}>
        <Text bold color="cyan">
          shortcuts
        </Text>
      </Box>
      {SHORTCUTS.map(([k, desc]) => (
        <Box key={k}>
          <Text color="yellow">{k.padEnd(keyW)}</Text>
          <Text dimColor>{'  ' + desc}</Text>
        </Box>
      ))}
    </Box>
  );
}

// Truncate to width, breaking on a word boundary when one is reasonably close,
// then pad so the selection highlight fills the row. Slices by code point —
// a .slice() through an emoji leaves a lone surrogate (renders as �).
function pad(s: string, n: number): string {
  const chars = Array.from(s);
  if (chars.length <= n) return s + ' '.repeat(n - chars.length);
  const slice = chars.slice(0, n - 1).join('');
  const sp = slice.lastIndexOf(' ');
  const base = sp >= Math.floor(n * 0.6) ? slice.slice(0, sp) : slice;
  return (base + '…').padEnd(n);
}

// One spinner clock for ALL running rows. ink-spinner gives every <Spinner> its
// own 80ms interval; with N running sessions that's N staggered timers, each
// tick forcing Ink to erase + rewrite the entire frame (Ink has no cell diff) —
// measured ~23 full-frame repaints/sec with 3 spinners, which is what made the
// sidebar shimmer. A single shared clock renders once per tick for everyone.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_MS = 120;

function StatusGlyph({ status, spin }: { status: RowStatus; spin: string }) {
  if (status === 'running') return <Text color="cyan">{spin}</Text>;
  if (status === 'ready')
    return (
      <Text color="green" bold>
        ▶
      </Text>
    );
  if (status === 'dead') return <Text color="red">✗</Text>;
  if (status === 'external')
    return (
      <Text color="yellow" bold>
        ●
      </Text>
    );
  return <Text color="gray">✓</Text>;
}

// Fixed (non-list) lines: header, hint, blank, then the detail block
// (blank + up to 2 title lines + cwd + status line), plus the row of headroom
// the rows-1 frame keeps for Ink. The status line is always reserved — it only
// sometimes has content (the 'external' warning), but growing the block on
// selection would overflow the frame and clip the warning exactly when it's
// needed.
const CHROME_LINES = 9;

function Dashboard() {
  const { stdout } = useStdout();
  // Resolved once: selfWindowId shells out to tmux, and the component renders
  // ~8×/sec while a spinner is animating — a spawnSync per render is jank.
  const [self] = useState(() => ({ pane: tmux.selfPaneId(), window: tmux.selfWindowId() }));
  const myPaneId = self.pane;
  const myWindowId = self.window;

  const [dims, setDims] = useState({
    cols: stdout?.columns ?? 40,
    rows: stdout?.rows ?? 24,
  });
  // Sidebar share of the terminal. Read from tmux once (it outlives a UI
  // respawn), then owned here: `[` / `]` retune it and every resize re-derives
  // the column count from it.
  const [ratio, setRatio] = useState(tmux.loadRatio);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setDims({ cols: stdout.columns, rows: stdout.rows });
      // The client-resized hook has already applied the percentage pin; this
      // applies the clamped exact width (a no-op in the normal range, and the
      // floor/ceiling at the extremes). stdout.columns is this PANE's width, so
      // the terminal width has to come from tmux.
      const want = tmux.sidebarCols(tmux.clientWidth(), ratioRef.current);
      if (want && want !== stdout.columns) tmux.resizePaneWidth(myPaneId, want);
    };
    stdout.on('resize', onResize);
    onResize();
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout, myPaneId]);

  const visibleRows = Math.max(3, dims.rows - CHROME_LINES);
  const titleWidth = Math.max(8, dims.cols - 5); // prefix(2) + glyph(1) + space(1) + margin

  // The stage = the other pane of the dashboard window. Always derived from
  // tmux, never cached in React state: the staged pane can vanish out from
  // under us (the session exits → its pane closes), and a cached id then
  // dangles — the original "Enter does nothing after claude quit" bug.
  const currentStage = useCallback(
    () => tmux.listPanes().find((p) => p.windowId === myWindowId && p.paneId !== myPaneId),
    [myWindowId, myPaneId],
  );

  const [rows, setRows] = useState<Row[]>([]);
  // Selection follows a session's stable identity (pane id for live rows,
  // transcript id for idle rows), NOT its slot — so the list can re-sort under
  // the cursor without the highlight drifting onto a different session.
  const [selectedKey, setSelectedKey] = useState('');
  // Pane currently on the stage — the session the user actually has open.
  // Sampled once per poll (not per render: currentStage() shells out to tmux)
  // and used as the fallback anchor for the highlight, so a re-sort can never
  // float it onto whatever session happened to finish most recently.
  const [stagePaneId, setStagePaneId] = useState('');
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  // The row being renamed, captured when `n` is pressed. The list keeps
  // re-sorting under the prompt; committing against the *current* selection
  // could rename whatever drifted under the cursor.
  const [renameKey, setRenameKey] = useState('');
  const [help, setHelp] = useState(false);

  const refresh = useCallback(() => {
    const next = buildRows();
    setRows(next);
    const stage = currentStage()?.paneId ?? '';
    setStagePaneId(stage);
    // A fork rebind (or a new session adopting its transcript) renames row keys
    // — follow it, so the highlight / an in-flight rename stay on the same
    // session.
    setSelectedKey((k) => {
      const key = keyAliases.get(k) ?? k;
      if (next.some((r) => r.key === key)) return key;
      // No row owns the selection: first paint, or the session it pointed at is
      // gone. Anchor it explicitly — to the session on the stage, else the top
      // row — rather than leaving it dangling, which resolves to slot 0 afresh
      // every poll and so rides the re-sort onto a different session.
      const staged = stage ? next.find((r) => r.live?.paneId === stage) : undefined;
      return staged?.key ?? next[0]?.key ?? '';
    });
    setRenameKey((k) => keyAliases.get(k) ?? k);
  }, [currentStage]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Shared spinner clock — only ticks while something is actually running.
  const hasRunning = rows.some((r) => r.status === 'running');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!hasRunning) return;
    const t = setInterval(() => setTick((n) => n + 1), SPINNER_MS);
    return () => clearInterval(t);
  }, [hasRunning]);
  const spin = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];

  const filtered = query
    ? rows.filter((r) => (r.title + ' ' + r.cwd).toLowerCase().includes(query.toLowerCase()))
    : rows;
  // Re-derive the cursor position from the selected identity every render. If
  // the selected row vanished (killed) or a filter hid it, fall back to the
  // session on the stage — the one the user has open — and only then to the
  // top, which the sort keeps handing to whatever wanted me last.
  const sel = filtered.findIndex((r) => r.key === selectedKey);
  const stageIdx = stagePaneId ? filtered.findIndex((r) => r.live?.paneId === stagePaneId) : -1;
  const clamped = sel >= 0 ? sel : stageIdx >= 0 ? stageIdx : 0;
  const selected = filtered[clamped];

  const showOnStage = useCallback(
    (paneId: string) => {
      if (!paneId) return;
      const stage = currentStage();
      if (!stage) {
        // Stage slot collapsed (the staged session exited, closing its pane).
        // Nothing to swap against — splice the chosen pane back in as a fresh
        // right-hand split, then restore the sidebar from the 50/50 default.
        tmux.joinPaneRight(paneId, myPaneId);
        const w = tmux.sidebarCols(tmux.clientWidth(), ratioRef.current);
        if (w) tmux.resizePaneWidth(myPaneId, w);
      } else if (paneId !== stage.paneId) {
        tmux.swapPane(paneId, stage.paneId);
      }
      tmux.selectPane(paneId); // jump focus into the session
    },
    [currentStage, myPaneId],
  );

  const openRow = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      if (row.live) {
        if (row.status === 'dead') {
          // claude exited but the pane was kept (remain-on-exit) — restart it
          // in place, resuming its transcript when we know one.
          const rid =
            row.historical?.id ?? (row.live.resumeId !== 'new' ? row.live.resumeId : undefined);
          tmux.respawnSession(row.live.paneId, rid, row.historical?.cwd || row.cwd);
        }
        setSelectedKey(row.key);
        showOnStage(row.live.paneId);
        return;
      }
      if (row.historical) {
        const pane = tmux.createSession({
          resumeId: row.historical.id,
          label: row.historical.title.slice(0, 40),
          cwd: row.historical.cwd,
        });
        if (pane) {
          setSelectedKey(row.historical.id); // row keys are transcript ids
          showOnStage(pane.paneId);
        }
        refresh();
      }
    },
    [showOnStage, refresh],
  );

  const newSession = useCallback(() => {
    const cwd = selected?.cwd && selected.cwd !== '~' ? selected.cwd : HOME;
    const pane = tmux.createSession({ resumeId: 'new', label: 'new session', cwd });
    if (pane) {
      setSelectedKey(pane.paneId);
      showOnStage(pane.paneId);
    }
    refresh();
  }, [selected, showOnStage, refresh]);

  const adjustSidebar = useCallback(
    (delta: number) => {
      // Nudge by columns (what the user sees), store as a ratio (what survives
      // a resize): the width you tune here becomes the share the sidebar keeps
      // when the terminal changes size.
      const cols = tmux.clientWidth() || dims.cols;
      // Derive the ratio from the width that actually gets applied (post-rails),
      // so holding `]` past the ceiling can't inflate a stored ratio that then
      // needs several `[` presses to visibly undo.
      const w = tmux.sidebarCols(cols, Math.max(20, dims.cols + delta) / cols);
      const next = w / cols;
      setRatio(next);
      tmux.pinSidebar(myPaneId, next, cols);
    },
    [dims.cols, myPaneId],
  );

  const commitRename = useCallback(() => {
    const row = rows.find((r) => r.key === renameKey);
    const v = renameValue.trim();
    if (row && v) {
      // permanent rename keys off the transcript id (historical or resumed)
      const sid = row.historical?.id ?? (row.live && row.live.resumeId !== 'new' ? row.live.resumeId : undefined);
      if (sid) setName(sid, v);
      // keep the live label in sync so the change shows immediately — using the
      // transcript id when we have one, so a rename during the adoption window
      // can't revert the pin back to 'new'
      if (row.live) tmux.setPaneTag(row.live.paneId, `s|${sid ?? 'new'}|${v.slice(0, 40)}`);
      refresh();
    }
    setRenaming(false); // empty input = cancel (no change)
  }, [rows, renameKey, renameValue, refresh]);

  const killSelected = useCallback(() => {
    if (!selected?.live) return;
    const victim = selected.live.paneId;
    // Hand the highlight to a neighbour before the row disappears, so it lands
    // next to what was killed instead of falling back to the top of the list.
    setSelectedKey(filtered[clamped + 1]?.key ?? filtered[clamped - 1]?.key ?? '');
    if (currentStage()?.paneId === victim) {
      const ph = tmux.paneByTag(tmux.PLACEHOLDER_TAG);
      if (ph) showOnStage(ph.paneId);
    }
    tmux.killPane(victim);
    // showOnStage focused the placeholder (right for Enter, wrong here) —
    // pull focus back so j/k/x keep working after a kill.
    tmux.selectPane(myPaneId);
    refresh();
  }, [selected, filtered, clamped, currentStage, showOnStage, refresh, myPaneId]);

  useInput((input, key) => {
    // text-entry modes capture everything; Ctrl-C / Esc cancel them
    if (renaming) {
      if (key.return) commitRename();
      else if (key.escape || (key.ctrl && input === 'c')) setRenaming(false);
      else if (key.ctrl && input === 'u') setRenameValue('');
      else if (key.backspace || key.delete) setRenameValue((v) => v.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setRenameValue((v) => v + input);
      return;
    }
    if (typing) {
      if (key.return || key.escape || (key.ctrl && input === 'c')) setTyping(false);
      else if (key.ctrl && input === 'u') setQuery('');
      else if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setQuery((q) => q + input);
      return;
    }
    // help overlay swallows everything; esc / ? / q close it
    if (help) {
      if (key.escape || input === '?' || input === 'q') setHelp(false);
      return;
    }
    if (input === '?') {
      setHelp(true);
    } else if (key.ctrl && input === 'c') {
      tmux.killServer(); // Ctrl-C → quit orc back to a clean terminal
    } else if (input === 'q') {
      tmux.killServer(); // quit orc + tear down all hosted sessions (kills this process too)
    } else if (input === 'd') {
      tmux.detachClient(); // detach only — UI keeps running so reattach is instant
    } else if (key.upArrow || input === 'k') {
      setSelectedKey(filtered[Math.max(0, clamped - 1)]?.key ?? selectedKey);
    } else if (key.downArrow || input === 'j') {
      setSelectedKey(filtered[Math.min(filtered.length - 1, clamped + 1)]?.key ?? selectedKey);
    } else if (key.return) {
      // A session being written elsewhere can't be safely resumed in place —
      // it's not openable; wait for it to go idle. Dormant rows open normally.
      if (selected?.status !== 'external') openRow(selected);
    } else if (key.tab) {
      const stage = currentStage();
      if (stage) tmux.selectPane(stage.paneId); // focus the session without changing selection
    } else if (input === 'n') {
      if (selected) {
        setRenameValue(''); // n = name/rename the highlighted chat (type the new name)
        setRenameKey(selected.key);
        setRenaming(true);
      }
    } else if (input === 'N') {
      newSession(); // shift-N = new session
    } else if (input === 'x') {
      killSelected();
    } else if (input === '[') {
      adjustSidebar(-4);
    } else if (input === ']') {
      adjustSidebar(4);
    } else if (input === '/') {
      setTyping(true);
    } else if (input === 'r') {
      refresh();
    }
  });

  const liveCount = rows.filter((r) => r.status === 'running' || r.status === 'ready').length;
  const start = Math.max(
    0,
    Math.min(clamped - Math.floor(visibleRows / 2), Math.max(0, filtered.length - visibleRows)),
  );
  const view = filtered.slice(start, start + visibleRows);

  // height is rows-1, not rows: a full-height frame makes Ink's trailing
  // newline overflow the pane, defeating its differential renderer and forcing
  // a full clear+repaint every frame — which the running-session spinner
  // (~80ms) then turns into constant flicker. One row of headroom keeps Ink in
  // diff mode so only changed cells repaint.
  return (
    <Box flexDirection="column" width={dims.cols} height={dims.rows - 1} overflow="hidden">
      <Box width={dims.cols}>
        <Text bold>orc</Text>
        <Text dimColor> · {liveCount} live / {rows.length}</Text>
      </Box>
      <Box width={dims.cols}>
        {renaming ? (
          <Text wrap="truncate">
            <Text dimColor>name “{rows.find((r) => r.key === renameKey)?.title ?? ''}”: </Text>
            <Text color="yellow">{renameValue}</Text>▏
          </Text>
        ) : typing ? (
          <Text wrap="truncate">
            filter: <Text color="yellow">{query}</Text>▏
          </Text>
        ) : (
          <Text dimColor wrap="truncate">↑↓ enter · n name · N new · x · / · ? help · q · d</Text>
        )}
      </Box>

      {help && <HelpOverlay width={dims.cols} />}

      {!help && (
      <>
      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 && <Text dimColor>no sessions</Text>}
        {view.map((r, i) => {
          const active = start + i === clamped;
          return (
            <Box key={r.key} width={dims.cols}>
              <Text>{active ? '❯ ' : '  '}</Text>
              <StatusGlyph status={r.status} spin={spin} />
              <Text> </Text>
              <Text
                backgroundColor={active ? 'cyan' : undefined}
                color={active ? 'black' : undefined}
                wrap="truncate"
              >
                {pad(r.title, titleWidth)}
              </Text>
            </Box>
          );
        })}
      </Box>

      {selected && (
        <Box flexDirection="column" marginTop={1} width={dims.cols}>
          {/* full name of the highlighted session — context the row can't fit */}
          <Box height={2} overflow="hidden">
            <Text>{selected.title}</Text>
          </Box>
          <Text dimColor wrap="truncate">
            {shortPath(selected.cwd)}
          </Text>
          <Text color="yellow" wrap="truncate">
            {selected.status === 'external'
              ? '● active in another window — wait for it to go idle to resume'
              : selected.status === 'dead'
                ? '✗ claude exited — Enter restarts it here'
                : ' '}
          </Text>
        </Box>
      )}
      </>
      )}
    </Box>
  );
}

// ===========================================================================
// Entry: route on the hidden subcommand.
// ===========================================================================
const mode = process.argv[2];
if (mode === '__pane') {
  // Ink repaints by erasing and rewriting the whole frame; mid-repaint the
  // terminal can paint a half-erased screen, which reads as flicker. Bracket
  // every write in DEC 2026 synchronized-update guards so tmux (3.4+) applies
  // each frame atomically. Terminals without 2026 ignore the sequences.
  const rawWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
    (rawWrite as (...a: unknown[]) => boolean)(
      typeof chunk === 'string' ? `\x1b[?2026h${chunk}\x1b[?2026l` : chunk,
      ...rest,
    )) as typeof process.stdout.write;
  render(<Dashboard />, { exitOnCtrlC: false }); // we handle Ctrl-C ourselves
} else if (mode === '__placeholder') {
  placeholder();
} else if (mode === 'kill') {
  tmux.killServer(); // `orc kill` — clean teardown without remembering the tmux command
  process.exit(0);
} else if (mode === '__rows') {
  // Debug: print the sidebar model without the UI (one line per row). Reads
  // the same tmux socket + transcripts a dashboard would; its only writes are
  // the fork re-pins buildRows always does.
  for (const r of buildRows()) {
    console.log(
      `${r.status.padEnd(8)} ${r.live?.paneId?.padEnd(5) ?? '-    '} ${r.key}  ${r.title}`,
    );
  }
  process.exit(0);
} else {
  bootstrap();
}
