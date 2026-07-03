import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as tmux from './tmux.js';
import { scanSessions, type Session } from './scanner.js';
import { loadNames, setName } from './names.js';

const ORC_BIN = fileURLToPath(new URL('../bin/orc.mjs', import.meta.url));
const NODE = process.execPath;
const HOME = homedir();
const POLL_MS = 1500;
const LEFT_COLS = 46;

const paneCmd = (sub: string) => `${NODE} ${ORC_BIN} ${sub}`;

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

  // Pin the sidebar to a sane width, and re-pin it whenever the client resizes
  // or attaches, so it never collapses or over-widens on smaller screens.
  const leftWidth = Math.max(24, Math.min(LEFT_COLS, Math.floor(cols * 0.42)));
  tmux.resizePaneWidth(left.paneId, leftWidth);
  const pin = `resize-pane -t ${left.paneId} -x ${leftWidth}`;
  tmux.setHook('client-resized', pin);
  tmux.setHook('client-attached', pin);

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
    // otherwise healthy → just attach
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
  /** sort key: transcript mtime (ms). Brand-new sessions with no transcript
   *  yet fall back to "now" so they surface at the top. */
  mtime: number;
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

function buildRows(): Row[] {
  const live = tmux.liveSessions();
  const history = scanSessions(); // newest mtime first
  const names = loadNames();

  // Transcript ids already represented by a live row — so they don't also show
  // up as a duplicate idle row below.
  const claimed = new Set<string>();
  // Reserve resumed sessions' transcripts up front, so a brand-new session in
  // the same cwd can't accidentally claim one of them.
  for (const l of live) {
    if (l.resumeId !== 'new') {
      const h = history.find((x) => x.id === l.resumeId);
      if (h) claimed.add(h.id);
    }
  }

  const rows: Row[] = [];
  for (const l of live) {
    if (l.resumeId !== 'new') {
      const h = history.find((x) => x.id === l.resumeId);
      rows.push({
        key: l.paneId,
        title: names[l.resumeId] ?? h?.title ?? l.label ?? '(new session)',
        cwd: l.cwd,
        status: liveStatus(l.status, h),
        mtime: h?.lastActivityMs ?? Date.now(),
        live: l,
        historical: h,
      });
      continue;
    }
    // Brand-new session: no resume id yet. Don't borrow a pre-existing
    // transcript's identity — only adopt one this pane created itself, i.e. a
    // transcript in the same cwd touched at/after the pane was born (which
    // happens once the user sends a first message). Until then it's just
    // "new session". `born === 0` (sessions created before this field existed)
    // falls back to the old freshest-in-cwd behaviour.
    const h = history.find(
      (x) => x.cwd === l.cwd && !claimed.has(x.id) && x.mtimeMs >= l.born,
    );
    if (h) {
      claimed.add(h.id);
      // Pin the identity to the real transcript id so subsequent polls take the
      // stable resumeId path and this binding can never flip again.
      const pinned = (names[h.id] ?? h.title).slice(0, 40);
      tmux.setPaneTag(l.paneId, `s|${h.id}|${pinned}`);
    }
    const title =
      (h && names[h.id]) ||
      (h && h.title && h.title !== '(untitled)' ? shortLabel(h.title) : 'new session');
    rows.push({
      key: l.paneId,
      title,
      cwd: l.cwd,
      status: liveStatus(l.status, h),
      mtime: h?.lastActivityMs ?? Date.now(),
      live: l,
      historical: h,
    });
  }
  for (const h of history) {
    if (claimed.has(h.id)) continue;
    rows.push({
      key: h.id,
      title: names[h.id] ?? h.title,
      cwd: h.cwd,
      // Unowned but being written by a claude outside orc → not safe to resume.
      status: transcriptBusy(h.id, h.mtimeMs, h.awaitingReply) ? 'external' : 'idle',
      mtime: h.lastActivityMs,
      historical: h,
    });
  }

  // Most-recently-active first, by last conversational turn (last message I sent
  // or last assistant/sub-agent activity) — NOT raw file mtime, which a bare
  // `--resume` on open would bump, floating a just-opened-but-untouched session
  // above one I actually messaged more recently. Brand-new sessions sort by
  // Date.now() (set above) so they surface at the top until their first turn.
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}

function shortPath(p: string): string {
  if (!p) return '';
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;
}

// Condense a first-prompt into a short, label-like name for the sidebar.
function shortLabel(s: string): string {
  const clean = (s || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= 40) return clean;
  const slice = clean.slice(0, 40);
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
// then pad so the selection highlight fills the row.
function pad(s: string, n: number): string {
  if (s.length <= n) return s.padEnd(n);
  const slice = s.slice(0, n - 1);
  const sp = slice.lastIndexOf(' ');
  const base = sp >= Math.floor(n * 0.6) ? slice.slice(0, sp) : slice;
  return (base + '…').padEnd(n);
}

function StatusGlyph({ status }: { status: RowStatus }) {
  if (status === 'running')
    return (
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
    );
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
// (blank + up to 2 title lines + cwd), with a line of slack.
const CHROME_LINES = 8;

function Dashboard() {
  const { stdout } = useStdout();
  const myPaneId = tmux.selfPaneId();
  const myWindowId = tmux.selfWindowId();

  const [dims, setDims] = useState({
    cols: stdout?.columns ?? 40,
    rows: stdout?.rows ?? 24,
  });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setDims({ cols: stdout.columns, rows: stdout.rows });
    stdout.on('resize', onResize);
    onResize();
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const visibleRows = Math.max(3, dims.rows - CHROME_LINES);
  const titleWidth = Math.max(8, dims.cols - 5); // prefix(2) + glyph(1) + space(1) + margin

  const initialStage = tmux
    .listPanes()
    .find((p) => p.windowId === myWindowId && p.paneId !== myPaneId);

  const [stagePaneId, setStagePaneId] = useState(initialStage?.paneId ?? '');
  const [rows, setRows] = useState<Row[]>([]);
  // Selection follows a session's stable identity (pane id for live rows,
  // transcript id for idle rows), NOT its slot — so the list can re-sort under
  // the cursor without the highlight drifting onto a different session.
  const [selectedKey, setSelectedKey] = useState('');
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [help, setHelp] = useState(false);

  const refresh = useCallback(() => setRows(buildRows()), []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const filtered = query
    ? rows.filter((r) => (r.title + ' ' + r.cwd).toLowerCase().includes(query.toLowerCase()))
    : rows;
  // Re-derive the cursor position from the selected identity every render. If
  // the selected row vanished (killed, or filtered out) fall back to the top.
  const sel = filtered.findIndex((r) => r.key === selectedKey);
  const clamped = sel >= 0 ? sel : 0;
  const selected = filtered[clamped];

  const showOnStage = useCallback(
    (paneId: string) => {
      if (!paneId) return;
      if (paneId !== stagePaneId) {
        tmux.swapPane(paneId, stagePaneId);
        setStagePaneId(paneId);
      }
      tmux.selectPane(paneId); // jump focus into the session
    },
    [stagePaneId],
  );

  const openRow = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      if (row.live) {
        setSelectedKey(row.live.paneId);
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
          setSelectedKey(pane.paneId);
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
      const w = Math.max(20, Math.min(100, dims.cols + delta));
      tmux.resizePaneWidth(myPaneId, w);
      // keep the resize/attach pin in sync so the chosen width persists
      const pin = `resize-pane -t ${myPaneId} -x ${w}`;
      tmux.setHook('client-resized', pin);
      tmux.setHook('client-attached', pin);
    },
    [dims.cols, myPaneId],
  );

  const commitRename = useCallback(() => {
    const row = selected;
    const v = renameValue.trim();
    if (row && v) {
      // permanent rename keys off the transcript id (historical or resumed)
      const sid = row.historical?.id ?? (row.live && row.live.resumeId !== 'new' ? row.live.resumeId : undefined);
      if (sid) setName(sid, v);
      // keep the live label in sync so the change shows immediately
      if (row.live) tmux.setPaneTag(row.live.paneId, `s|${row.live.resumeId}|${v.slice(0, 40)}`);
      refresh();
    }
    setRenaming(false); // empty input = cancel (no change)
  }, [selected, renameValue, refresh]);

  const killSelected = useCallback(() => {
    if (!selected?.live) return;
    const victim = selected.live.paneId;
    if (stagePaneId === victim) {
      const ph = tmux.paneByTag(tmux.PLACEHOLDER_TAG);
      if (ph) showOnStage(ph.paneId);
    }
    tmux.killPane(victim);
    refresh();
  }, [selected, stagePaneId, showOnStage, refresh]);

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
      tmux.selectPane(stagePaneId); // focus the session without changing selection
    } else if (input === 'n') {
      if (selected) {
        setRenameValue(''); // n = name/rename the highlighted chat (type the new name)
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
            <Text dimColor>name “{selected?.title ?? ''}”: </Text>
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
              <StatusGlyph status={r.status} />
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
          {selected.status === 'external' && (
            <Text color="yellow" wrap="truncate">
              ● active in another window — wait for it to go idle to resume
            </Text>
          )}
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
  render(<Dashboard />, { exitOnCtrlC: false }); // we handle Ctrl-C ourselves
} else if (mode === '__placeholder') {
  placeholder();
} else if (mode === 'kill') {
  tmux.killServer(); // `orc kill` — clean teardown without remembering the tmux command
  process.exit(0);
} else {
  bootstrap();
}
