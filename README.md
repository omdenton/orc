# orc

A terminal dashboard for **Claude Code sessions that keep running in the
background**. Your sessions list down the left; the live session on the right;
pick one and it swaps onto the stage. Pop out and it keeps thinking. Built on
tmux (on its own isolated socket — your normal tmux is untouched).

```
┌───────────────────────┬────────────────────────────────────┐
│ orc · 1 live / 64      │  (the selected session, live)       │
│ ↑↓ enter n x / q       │                                     │
│  ▶ ecm-org-setup       │  ❯ …interactive claude, yours…      │
│ ❯⠹ api-refactor        │                                     │
│  ✓ digest              │  ⏵⏵ bypass permissions on           │
│  ✓ notes               │                                     │
└───────────────────────┴────────────────────────────────────┘
```

## Status icons

| Icon | State | Meaning |
|------|-------|---------|
| spinner (cyan) | **running** | actively working right now (working footer on screen, or the transcript / sub-agent files advancing) |
| `▶` (green) | **ready for input** | live and waiting on you |
| `✗` (red) | **dead** | claude exited — select + Enter to restart |
| `✓` (grey) | **idle** | a past session, not running — Enter starts it in the background |
| `●` (yellow) | **active elsewhere** | a session being driven by a claude *outside* orc (another terminal/IDE) — not openable; wait for it to go idle, then resume it here |

**Resume forks.** Newer Claude Code doesn't append to a transcript on
`--resume` — it copies the history into a *new* session file (new id) and
continues there. orc follows the fork: each conversation shows as **one** row
(the newest file), stale ancestor files are hidden, saved names carry across,
and a live pane's identity is re-pinned so restarting it resumes the newest
file rather than a stale ancestor.

## Order

The list is sorted by **what last wanted you**: the session you most recently
typed in, or one that has gone quiet waiting on your input. Work in flight
doesn't count — a background session churning through a long task holds its
place instead of shoving the conversation you're actually having down the list,
and it re-surfaces the moment it finishes and needs an answer. Nothing is
pinned: send a message somewhere else and that session takes the top, while
whatever was waiting slides down.

## Keys (in the left list)

`↑↓`/`jk` move · `Enter` open (starts idle ones) → stage + focus · `Tab` focus
the session · `n` **name/rename** the highlighted chat · `N` new session · `x`
kill · `[` / `]` shrink/grow the sidebar (see below) · `/` filter ·
`r` refresh · `?` **help** (a floating shortcut cheatsheet; `Esc` closes).

A brand-new session (`N`) is labelled `new session` only until you send your
first message — then it auto-renames to a short name derived from that prompt.
Press `n` any time to override it with your own name.

**Renaming** (`n`): type the new name and `Enter` (empty = cancel, `Ctrl-U`
clears). Names are saved to `~/.config/orc/names.json`, keyed by the session's
transcript id, so they **persist across restarts**. Renaming a brand-new session
(no transcript id yet) updates the label for this run only.

**Quitting:**
- `q` or `Ctrl-C` — **quit orc and tear everything down** (the dashboard + all
  hosted sessions), back to a clean terminal. Sessions are still resumable from
  history next launch.
- `d` — **detach only**: leave every session running in the background; re-run
  `orc` to reattach right where you left off.

**Sidebar width** is a *share* of the terminal (~22% by default), not a fixed
column count — so when your window manager retiles around orc, the sidebar keeps
its proportion instead of swelling to half the window on a narrow terminal and
shrinking to a sliver on a wide one. `[` / `]` nudge it by a few columns and the
width you land on becomes the new share, remembered for every later resize.

You can also **drag the pane divider with the mouse** to resize (mouse mode is
on) — though a drag isn't recorded as a new share, so a later terminal resize
snaps back to the `[`/`]` proportion.

**Move focus back to the list** from inside a session: `Alt-←` (or `Alt-h`).
Forward: `Alt-→` / `Alt-l`. Native tmux `Ctrl-b ←/→`, and `Ctrl-b z` to zoom the
session fullscreen, also work.

Every session runs `claude --resume <id> --dangerously-skip-permissions` in its
own directory. If claude exits, the pane is kept and the row turns `✗` — press
Enter to restart it in place.

## Recovery

- **UI glitched or crashed?** Just run `orc` again. Bootstrap detects a dead UI
  pane and respawns it **in place — your running sessions are preserved**. (If the
  whole layout is gone, it rebuilds fresh; sessions are still resumable from
  history.)
- **Clean teardown:** `orc kill` — kills the whole orc server (dashboard + all
  sessions) without needing any tmux commands. Same as pressing `q` inside.
- A reboot clears the orc tmux server entirely, so you always start clean.

## Install

```bash
cd ~/projects/orc
npm install
npm link        # puts `orc` on your PATH (already linked on this machine)
```

Then, from anywhere:

```bash
orc
```

Requires `tmux` (already installed here).

## Develop / test

```bash
npm start          # bootstrap from source (tsx)
npm run stagetest  # non-interactive: verify the stage swap + status logic
```

Hidden subcommands used internally by the dashboard: `orc __pane` (the Ink UI in
the left pane), `orc __placeholder` (the empty-stage hint).

## How it works

- **Each session** = a detached tmux session running claude → keeps running
  off-screen.
- **Dashboard** = one tmux session, left pane = orc UI, right = "the stage."
- **Switching** = a single `swap-pane` by pane-id; pane count is conserved so no
  session is ever destroyed.
- **Identity** = a pane-scoped `@orc` option (Claude can't clobber it, unlike the
  pane title), so sessions are tracked reliably across swaps.
- **Status** = each pane's `pane_current_command` + a `capture-pane` scan for
  Claude's working footer, OR'd with transcript freshness — including the
  sub-agent / workflow files Claude writes under
  `~/.claude/projects/<proj>/<session-id>/`, so a session waiting on sub-agents
  still reads as running while its main transcript is quiet.

The screen markers are tunable in `src/tmux.ts` (`WORKING_MODE_LINE`,
`WORKING_STATUS_LINE`, `BG_WAIT_FOOTER`) — they're coupled to Claude Code's
UI wording, so re-verify them against a real session if status misreports.

See `SPEC.md` for the full design and what's verified vs. needs a real terminal.
