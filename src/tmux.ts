import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * All orc tmux state lives on a dedicated socket so it never collides with the
 * user's normal tmux server, and we can set root key-bindings freely.
 *
 * Overridable via $ORC_SOCKET so destructive tooling (stage-test, which calls
 * kill-server) can run on a throwaway socket and NEVER touch a live `orc`
 * dashboard + its hosted sessions. Production always uses the default 'orc'.
 */
export const SOCKET = process.env.ORC_SOCKET || 'orc';
export const DASH_SESSION = 'orc';
export const SESSION_PREFIX = 'orc-';

// Pane identity is carried in a pane-scoped tmux user option `@orc` (NOT the
// pane title — Claude Code sets its own title and would clobber it). The option
// travels with the pane across swap-pane and is invisible to the app.
export const DASH_TAG = '__dash__';
export const PLACEHOLDER_TAG = '__placeholder__';
const SESSION_TAG_PREFIX = 's|'; // s|<resumeId>|<label>

// tmux sanitises non-printable characters in format output (tabs become '_')
// whenever the *client* runs without a UTF-8 locale, and renders non-ASCII in
// attached panes the same way. That is the norm over SSH, where LANG is rarely
// forwarded. Our pane parser splits on tabs, so give every tmux client we spawn
// a UTF-8 locale when the environment has none. A server started by such a
// client inherits it too, so hosted sessions render correctly as well.
export const TMUX_ENV: NodeJS.ProcessEnv = (() => {
  const e = process.env;
  const loc = e.LC_ALL || e.LC_CTYPE || e.LANG || '';
  if (/utf-?8/i.test(loc)) return e;
  return { ...e, LANG: 'C.UTF-8', ...(e.LC_ALL ? { LC_ALL: 'C.UTF-8' } : {}) };
})();

function tmux(args: string[]) {
  const r = spawnSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8', env: TMUX_ENV });
  return {
    code: r.status ?? 1,
    stdout: (r.stdout ?? '').replace(/\n$/, ''),
    stderr: r.stderr ?? '',
  };
}

export function tmuxAvailable(): boolean {
  const r = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  return (r.status ?? 1) === 0;
}

export function hasSession(name: string): boolean {
  return tmux(['has-session', '-t', name]).code === 0;
}

// ---------------------------------------------------------------------------
// Pane queries
// ---------------------------------------------------------------------------

export interface PaneInfo {
  session: string;
  windowId: string;
  paneId: string;
  tag: string; // our @orc identity option
  cmd: string;
  cwd: string;
  dead: boolean; // process exited but pane kept (remain-on-exit)
  born: string; // @orc_born: ms timestamp the pane was created (or '' if unset)
  sid: string; // @orc_sid: session id we handed claude at birth ('' if unset)
}

const PANE_FMT = [
  '#{session_name}',
  '#{window_id}',
  '#{pane_id}',
  '#{@orc}',
  '#{pane_current_command}',
  '#{pane_current_path}',
  '#{pane_dead}',
  '#{@orc_born}',
  '#{@orc_sid}',
].join('\t');

export function listPanes(): PaneInfo[] {
  const r = tmux(['list-panes', '-a', '-F', PANE_FMT]);
  if (r.code !== 0 || !r.stdout) return [];
  const out: PaneInfo[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const [session, windowId, paneId, tag, cmd, cwd, dead, born, sid] = line.split('\t');
    out.push({
      session,
      windowId,
      paneId,
      tag: tag ?? '',
      cmd,
      cwd,
      dead: dead === '1',
      born: born ?? '',
      sid: sid ?? '',
    });
  }
  return out;
}

export function paneByTag(tag: string): PaneInfo | undefined {
  return listPanes().find((p) => p.tag === tag);
}

/** Width (in cols) of the attached client — the whole terminal — or 0 if none. */
export function clientWidth(): number {
  return Number(tmux(['display-message', '-p', '#{client_width}']).stdout) || 0;
}

/** Evaluate a tmux format against a target (pane/window); '' if unavailable. */
export function displayFor(target: string, fmt: string): string {
  const r = tmux(['display-message', '-p', '-t', target, fmt]);
  return r.code === 0 ? r.stdout : '';
}

/** The pane this process is running in. Uses $TMUX_PANE (set by tmux in every
 *  pane) so it resolves even when no client is attached. */
export function selfPaneId(): string {
  return process.env.TMUX_PANE ?? tmux(['display-message', '-p', '#{pane_id}']).stdout;
}

export function selfWindowId(): string {
  const pane = process.env.TMUX_PANE;
  const args = pane
    ? ['display-message', '-p', '-t', pane, '#{window_id}']
    : ['display-message', '-p', '#{window_id}'];
  return tmux(args).stdout;
}

// ---------------------------------------------------------------------------
// Pane operations
// ---------------------------------------------------------------------------

/** Tag a pane with our identity option (survives Claude renaming the title).
 *  Tags travel through tab-separated list-panes output, so strip separators —
 *  an aiTitle with a tab/newline would shift every field after it. */
export function setPaneTag(paneId: string, tag: string): void {
  tmux(['set-option', '-p', '-t', paneId, '@orc', tag.replace(/[\t\n\r]+/g, ' ')]);
}

export function setPaneOption(paneId: string, opt: string, val: string): void {
  tmux(['set-option', '-p', '-t', paneId, opt, val]);
}

/** Restart a pane's command in place (keeps the pane id, tag, and options). */
export function respawnPane(paneId: string, command: string): void {
  tmux(['respawn-pane', '-k', '-t', paneId, command]);
}

export function capturePane(paneId: string): string {
  const r = tmux(['capture-pane', '-t', paneId, '-p']);
  return r.code === 0 ? r.stdout : '';
}

export function selectPane(paneId: string): void {
  tmux(['select-pane', '-t', paneId]);
}

/** Bring `src` into `dst`'s position; `dst` is sent to `src`'s old position. */
export function swapPane(srcPaneId: string, dstPaneId: string): void {
  tmux(['swap-pane', '-s', srcPaneId, '-t', dstPaneId]);
}

/**
 * Move `src` into `target`'s window as a right-hand split (`target` on the left).
 * Used to re-establish the stage slot when the staged session exited and closed
 * its pane, collapsing the dashboard window back to just the sidebar — there's
 * nothing left to swap against, so we splice the chosen pane back in instead.
 */
export function joinPaneRight(srcPaneId: string, targetPaneId: string): void {
  tmux(['join-pane', '-h', '-s', srcPaneId, '-t', targetPaneId]);
}

export function killPane(paneId: string): void {
  tmux(['kill-pane', '-t', paneId]);
}

export function detachClient(): void {
  tmux(['detach-client']);
}

/** Tear down the entire orc server: dashboard + every hosted session. */
export function killServer(): void {
  tmux(['kill-server']);
}

export function killSession(name: string): void {
  tmux(['kill-session', '-t', name]);
}

// ---------------------------------------------------------------------------
// Dashboard bootstrap helpers
// ---------------------------------------------------------------------------

export function newDashboard(cols: number, rows: number, command: string): void {
  tmux(['new-session', '-d', '-s', DASH_SESSION, '-x', String(cols), '-y', String(rows), command]);
}

export function splitRight(targetPaneId: string, command: string): void {
  tmux(['split-window', '-h', '-t', targetPaneId, command]);
}

export function resizePaneWidth(paneId: string, cols: number): void {
  tmux(['resize-pane', '-t', paneId, '-x', String(cols)]);
}

// ---------------------------------------------------------------------------
// Sidebar geometry
// ---------------------------------------------------------------------------

// The sidebar is sized as a FRACTION of the terminal, not a fixed column count.
// A fixed count is what made the layout lurch when the window manager retiles
// around orc: 40 cols is a comfortable ~22% of a 185-col full-screen terminal,
// but 42% of the same terminal at half-screen width. The default below is that
// hand-tuned full-screen width expressed as a proportion, so every resize keeps
// the proportion. `[` / `]` retune it, and it is remembered as a ratio rather
// than a width (see RATIO_OPT).
export const SIDEBAR_RATIO = 40 / 185; // ≈ 0.216
// Safety rails, not policy: the ratio decides the width, these only stop it
// collapsing to nothing or crowding the stage out at extreme terminal sizes.
export const SIDEBAR_FLOOR = 12;
export const SIDEBAR_CEIL_FRAC = 0.6;
/** tmux user option holding the live ratio, so it survives a UI respawn. */
export const RATIO_OPT = '@orc_ratio';

/** Sidebar width in columns for a terminal `clientCols` wide (0 if unknown). */
export function sidebarCols(clientCols: number, ratio: number): number {
  if (!clientCols) return 0;
  const ceil = Math.max(SIDEBAR_FLOOR, Math.floor(clientCols * SIDEBAR_CEIL_FRAC));
  return Math.max(SIDEBAR_FLOOR, Math.min(ceil, Math.round(clientCols * ratio)));
}

/** The remembered ratio, or the default when unset / out of sane bounds. */
export function loadRatio(): number {
  const v = Number(getGlobalOption(RATIO_OPT));
  return v > 0.05 && v < 0.9 ? v : SIDEBAR_RATIO;
}

/**
 * Pin the sidebar to `ratio` of the terminal: remember it, apply it now, and
 * re-pin whenever the terminal changes size. The hooks use tmux's own
 * percentage form, so the proportion holds even while the UI is busy or has
 * crashed; the UI additionally applies the railed exact width on its SIGWINCH.
 *
 * The hook is `window-resized`, NOT `client-resized`: client-resized runs
 * BEFORE tmux relays out the window, so anything it resizes is immediately
 * undone by the relayout — measured identical to having no hook at all, which
 * is why a terminal resize used to crush the sidebar to a single column (tmux's
 * own redistribution) no matter what width was pinned. window-resized runs
 * after the new geometry settles, where a resize sticks.
 */
export function pinSidebar(paneId: string, ratio: number, clientCols: number): void {
  setGlobalOption(RATIO_OPT, String(ratio));
  const w = sidebarCols(clientCols, ratio);
  if (w) resizePaneWidth(paneId, w);
  const pin = `resize-pane -t ${paneId} -x ${Math.round(ratio * 100)}%`;
  setHook('window-resized', pin);
  setHook('client-attached', pin); // attaching at the same size doesn't resize
  unsetHook('client-resized'); // clear the ineffective pin older orcs left set
}

export function bindRootKey(key: string, ...cmd: string[]): void {
  tmux(['bind-key', '-n', key, ...cmd]);
}

/** Remove a root-table binding (e.g. one leaked in from the user's tmux.conf). */
export function unbindRootKey(key: string): void {
  tmux(['unbind-key', '-n', key]);
}

/** Bind a key/event within a specific tmux key table (e.g. 'copy-mode-vi'). */
export function bindKeyInTable(table: string, key: string, ...cmd: string[]): void {
  tmux(['bind-key', '-T', table, key, ...cmd]);
}

export function setGlobalOption(opt: string, val: string): void {
  tmux(['set-option', '-g', opt, val]);
}

/** Read a global option (including @user options); '' if unset. */
export function getGlobalOption(opt: string): string {
  const r = tmux(['show-options', '-gqv', opt]);
  return r.code === 0 ? r.stdout : '';
}

export function setWindowOption(opt: string, val: string): void {
  tmux(['set-window-option', '-g', opt, val]);
}

export function setHook(hook: string, command: string): void {
  tmux(['set-hook', '-g', hook, command]);
}

export function unsetHook(hook: string): void {
  tmux(['set-hook', '-gu', hook]);
}

export function selectLayout(name: string): void {
  tmux(['select-layout', name]);
}

/** Attach to the dashboard, blocking until the client detaches. */
export function attachBlocking(): number {
  const env = { ...TMUX_ENV }; // UTF-8 locale, so the client renders hosted panes properly
  delete env.TMUX; // allow attaching even when launched from inside another tmux
  const r = spawnSync('tmux', ['-L', SOCKET, 'attach-session', '-t', DASH_SESSION], {
    stdio: 'inherit',
    env,
  });
  return r.status ?? 0;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type Status = 'running' | 'ready' | 'dead';

// Claude's live-status indicator only ever lives in the BOTTOM CHROME — the
// `⏵⏵ … esc to interrupt …` mode line, and the dim status slot just above the
// input box. It is NEVER in the scrollback. We must scope the scan to the last
// few lines: the same phrases ("esc to interrupt", "… to finish") routinely
// appear in the *conversation itself* (a chat about Claude's own UI is the
// cautionary example), and a whole-pane scan matches that prose and pins the
// session to "running" forever. Verify these against a real session if status
// starts misreporting — they're coupled to Claude Code's wording.

// The interruptible-turn hint, shown in the bottom `⏵⏵` mode line only while a
// turn is actively working: "… (shift+tab to cycle) · esc to interrupt · …".
// Absent when idle. Scanned in the bottom few lines (chrome), never the body.
// Newer Claude Code sometimes drops this hint mid-turn (e.g. with a queued
// message in the input box), so it is no longer sufficient on its own — see
// WORKING_STATUS_LINE.
const WORKING_MODE_LINE = /\besc to interrupt\b/i;
// The animated status line above the input box, present for the whole working
// turn: "✽ Doodling… (4m 59s · ↓ 13.2k tokens · thinking)". Shape-anchored:
// leading spinner glyph, one verb, ellipsis, then "(<elapsed>" — the done
// state ("✻ Cooked for 21s") has no "… (" and can't match, and a transcript
// line quoting the phrase starts with prose, failing the anchor.
const WORKING_STATUS_LINE = /^\s*[^\w\s]\s+\w+…\s+\(\d+[hms]/imu;
// The background-wait status line: shown when the main turn has ENDED but a
// dynamic workflow / background agents (ultracode) are still running — there is
// no "esc to interrupt" then. Real form: "✻ Waiting for 1 dynamic workflow to
// finish". Anchored to a whole line — leading spinner glyph + spaces allowed,
// then it must START with "Waiting for N" and END with "to finish" — so the
// phrase embedded in a transcript sentence ("…the 'Waiting for … to finish'
// footer…") can't trigger it (that line starts with other words).
const BG_WAIT_FOOTER = /^[^\w\n]*waiting for \d+\b.*\bto finish[^\S\n]*$/im;
// Commands that mean "claude is still the foreground process in this pane".
const CLAUDE_CMDS = new Set(['claude', 'node', 'bun', 'deno']);

/** Last `n` lines of `text` (trailing blanks trimmed first), as one string. */
function tailLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/** Pure classifier — `cmd` is the pane's foreground command, `text` its screen. */
export function classifyCapture(cmd: string, text: string): Status {
  if (!CLAUDE_CMDS.has(cmd)) return 'dead'; // dropped back to a shell
  // Mode line sits in the last ~5 lines (input box + mode/context chrome).
  if (WORKING_MODE_LINE.test(tailLines(text, 5))) return 'running';
  // The working status line sits above the input box; tips / queued messages
  // can push it a few lines up, so allow more headroom.
  if (WORKING_STATUS_LINE.test(tailLines(text, 10))) return 'running';
  // The bg-wait status slot sits just above the input box; allow more headroom.
  if (BG_WAIT_FOOTER.test(tailLines(text, 10))) return 'running';
  return 'ready';
}

export function statusOfPane(pane: PaneInfo): Status {
  // A remain-on-exit corpse: claude exited but the pane was kept so the
  // session can be restarted in place (Enter). The capture still shows
  // claude's final screen, so check the flag before classifying.
  if (pane.dead) return 'dead';
  return classifyCapture(pane.cmd, capturePane(pane.paneId));
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface LiveSession {
  paneId: string;
  tmuxSession: string;
  windowId: string;
  resumeId: string; // claude session id this was started from, or 'new'
  label: string;
  cwd: string;
  status: Status;
  born: number; // ms timestamp the pane was created (0 if pre-dates this field)
  /** For a brand-new session: the session id we pre-assigned it via
   *  `--session-id`, so its transcript is identifiable the moment it appears
   *  ('' for panes started before this existed). */
  sid: string;
}

function parseSessionTag(tag: string): { resumeId: string; label: string } | null {
  if (!tag.startsWith(SESSION_TAG_PREFIX)) return null;
  const rest = tag.slice(SESSION_TAG_PREFIX.length);
  const sep = rest.indexOf('|');
  if (sep < 0) return { resumeId: rest, label: '' };
  return { resumeId: rest.slice(0, sep), label: rest.slice(sep + 1) };
}

/** All claude sessions orc is hosting (identified by the @orc pane option). */
export function liveSessions(): LiveSession[] {
  const out: LiveSession[] = [];
  for (const p of listPanes()) {
    const parsed = parseSessionTag(p.tag);
    if (!parsed) continue;
    out.push({
      paneId: p.paneId,
      tmuxSession: p.session,
      windowId: p.windowId,
      resumeId: parsed.resumeId,
      label: parsed.label,
      cwd: p.cwd,
      status: statusOfPane(p),
      born: Number(p.born) || 0,
      sid: p.sid,
    });
  }
  return out;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Resuming keys off an existing transcript; a brand-new session instead gets a
// session id we choose, so its transcript is named before it exists and orc
// never has to guess which pane wrote which file.
function claudeCmd(resumeId?: string, sessionId?: string): string {
  const argv = ['claude', '--dangerously-skip-permissions'];
  if (resumeId && resumeId !== 'new') argv.push('--resume', resumeId);
  else if (sessionId) argv.push('--session-id', sessionId);
  return argv.map(shellQuote).join(' ');
}

let counter = 0;

export interface CreateOpts {
  label: string;
  cwd: string;
  resumeId?: string;
}

/**
 * Start a new background claude session (detached). Always skips permissions.
 * Returns the new pane, or null if tmux refused.
 */
export function createSession(opts: CreateOpts): PaneInfo | null {
  const name = `${SESSION_PREFIX}${Date.now().toString(36)}${(counter++).toString(36)}`;
  // Old transcripts can point at since-deleted directories; tmux refuses
  // `new-session -c <missing>` and the open would silently no-op.
  const cwd = existsSync(opts.cwd) ? opts.cwd : homedir();

  const resuming = opts.resumeId && opts.resumeId !== 'new';
  const sid = resuming ? '' : randomUUID();

  const r = tmux(['new-session', '-d', '-s', name, '-c', cwd, claudeCmd(opts.resumeId, sid)]);
  if (r.code !== 0) return null;

  const pane = listPanes().find((p) => p.session === name);
  if (!pane) return null;

  const tag = `${SESSION_TAG_PREFIX}${opts.resumeId ?? 'new'}|${opts.label}`;
  setPaneTag(pane.paneId, tag);
  // The id claude will write its transcript under, so the UI can adopt that
  // transcript by name the moment it appears (first message) rather than
  // guessing from cwd + timing.
  if (sid) setPaneOption(pane.paneId, '@orc_sid', sid);
  // Birth timestamp: lets the UI tell a brand-new session's own transcript
  // (written once the user sends a message) from pre-existing ones in the cwd.
  setPaneOption(pane.paneId, '@orc_born', String(Date.now()));
  // Keep the pane when claude exits, so the session shows as dead (✗) and can
  // be restarted in place with Enter — instead of vanishing (and collapsing
  // the dashboard window if it was on stage).
  setPaneOption(pane.paneId, 'remain-on-exit', 'on');
  return { ...pane, tag, born: String(Date.now()), sid };
}

/** Restart claude in a dead session pane (remain-on-exit corpse), in place. */
export function respawnSession(paneId: string, resumeId: string | undefined, cwd: string): void {
  const dir = existsSync(cwd) ? cwd : homedir();
  // No transcript to resume (it died before the first message): start over
  // under a *fresh* id, and re-pin it. Reusing the old one would be rejected by
  // claude if that pane did get as far as writing a transcript.
  const sid = resumeId ? '' : randomUUID();
  if (sid) setPaneOption(paneId, '@orc_sid', sid);
  tmux(['respawn-pane', '-k', '-c', dir, '-t', paneId, claudeCmd(resumeId, sid)]);
}
