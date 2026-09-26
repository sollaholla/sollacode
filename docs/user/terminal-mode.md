# Terminal mode

Every thread has a main surface: the chat timeline (default) or a terminal
workspace. Terminal mode turns the thread's main column into a multi-pane
terminal - the sidebar, header, and right panel stay where they are - so you
can run any agent CLI (or several at once) directly instead of driving one
through chat.

## Choosing a mode

A new thread starts in chat mode. The draft screen shows a **Chat / Terminal**
toggle under the headline; pick **Terminal** to start the thread as a terminal
workspace. That stores the thread immediately - you do not have to send a
message to a model first - so it appears in the sidebar and survives restart.
Any thread - new or existing - can also switch from the header
icon: a terminal icon in chat mode, a chat icon in terminal mode. That
control is the mode switch, not the bottom drawer. The drawer is a separate
chat-mode panel (the bottom-panel button); opening or closing it does not
change mode, and flipping mode does not open or close the drawer. Terminal
mode hides the drawer while it is active so the same panes are not attached
twice; if the drawer was open, it is still open when you return to chat.
The same thread keeps its messages, terminals, and layout when you flip back
and forth.

## The workspace

- Each pane has a tab heading with the terminal's label (the running command
  when one is active). An agent CLI (Claude, Grok, Codex, …) shows that
  provider's icon on the pane; the header, sidebar, and composer keep a
  generic terminal icon. A blue working dot appears only while the TUI is
  mid-turn - sitting on a home screen is not working.
- Terminal mode keeps the split/panel workspace: pane headings, nested
  splits, and the group side rail. The chat-mode titlebar controls for the
  terminal drawer and right panel are hidden, and the right panel stays
  collapsed until you return to chat. Fullscreen is off by default. Each
  pane heading has split, new, close, and fullscreen actions for that
  pane; the same fullscreen control on the tab strip exits fullscreen
  back to the panels. Mobile shows tabs above the surface when more than
  one terminal is open.
- Splitting a pane from its heading divides that pane in half
  horizontally or vertically and leaves the rest of the layout untouched, so
  splits nest - e.g. two side-by-side panes where the right one is stacked
  into top/bottom (max 4 panes per group). Groups beyond the first appear in
  the side rail.
- Drag a pane by its heading to rearrange. While dragging, the pane under the
  cursor highlights what will happen: hovering its center marks a swap, and
  hovering an edge (left/right/top/bottom) highlights that half of the pane -
  dropping there splits it and places the dragged terminal on that side.
- Drag files, images, or folders from the desktop (or a path from the file
  tree) onto a pane to type their paths into the terminal. A full-pane overlay
  shows whether the drop will be accepted or rejected. Paths are available in
  the desktop app; the browser cannot read OS file paths, so those drops are
  rejected there. Plain text and URLs still insert.
- Drag the divider between panes to resize them. Sizes persist per thread.
- When the same thread is open on several computers, one focused client owns pane-layout edits.
  A focused desktop host has priority; when it loses focus, a focused remote browser or mobile
  client takes over. Other clients mirror the accepted layout instead of repeatedly overwriting it.
- The group sidebar is resizable: drag its left edge. Drag terminals in the
  list to reorder them inside a group or drop them onto another group (a
  group that already has four panes will not accept another). Drag a group
  header to reorder groups. Double-click a group header to rename the group
  (blank restores the default "Group N"); terminal entries rename themselves
  automatically after the command they run. Split, new, close, and
  fullscreen live on each pane heading, not on the group rail.
- The provider usage pill appears top-center - the same placement the New
  Thread view uses - since terminal mode hides the composer footer.
- Hold Cmd+D on macOS or Ctrl+D on Windows and Linux to dictate into the selected terminal:
  while a terminal pane is focused or terminal mode is active, the transcript
  is typed into that terminal instead of the chat composer. A
  listening/transcribing chip floats bottom-center while the recording is in
  flight. The chord is reserved exclusively for voice transcription rather
  than terminal splitting or the diff viewer.
- All terminal keybindings work (`terminal.split`, `terminal.new`,
  `terminal.close`, navigation). Terminal mode and the drawer share the
  thread's terminals and layout, but their chrome is separate: mode fills
  the main column, the drawer is the bottom panel on the chat UI.

The main chat - not only the orchestrator - can see those panes. One
`thread_terminals` `list_terminals` call is enough: it returns every live
pane with the owning thread's title, whether the pane is on this chat's
thread, the running-command label, and a preview of what is on screen. A
Grok or Claude CLI in this thread's drawer is a separate process, not the
chat agent. `read_terminal` is only for a longer tail; `write_to_terminal`
types into a live pane. The orchestrator's matching actions do the same
from the orchestrator thread.

Codex, Claude, and Grok launched from an integrated terminal automatically receive a
thread-scoped, credential-bound Solla MCP connection. Users do not need to add or repair a
project `.mcp.json`. On Windows, Solla passes Claude a short-lived generated configuration file
instead of inline JSON, avoiding PowerShell argument quoting failures without storing the bearer
credential in that file.

Terminal mode is available on web and desktop. On mobile, a thread's
terminals open as a fullscreen tabbed screen instead: the thread-list
sidebar hides while the terminal is open and is restored when you leave,
and the tab strip above the surface switches between shells when more
than one terminal is open. Mobile has no multi-pane split view; web and
desktop keep their splits, panels, and per-pane fullscreen controls.

## Rendering notes

The host keeps a parsed terminal screen, including colors, cursor position,
the alternate screen, and input modes. Reattaching restores that screen at
the host's grid dimensions. Older diagnostic output can be truncated without
cutting escape sequences out of the screen replay. This requires an updated
host as well as an updated viewer, including when a Mac views Windows terminals.

Live output appends without resetting the viewport. When a hidden pane's
cached replay has exceeded its limit, it obtains a fresh screen from the host
before remounting. Attaching or revealing a pane does not nudge the shared PTY
through artificial size changes. Only a real size change from the controlling
client resizes it. The cursor does not blink by default; a CLI can choose its
own cursor behavior. Slow subscribers apply backpressure to PTY reads so control
bytes are retained through output bursts.

Inactive terminal viewports are destroyed to avoid retaining hidden xterm/WebGL renderers; their
server-side PTYs keep running. When a pane is mounted again, its own restoring overlay hides the
retained-history replay and the short follow-up repaint until that pane has been quiet for a bounded
settling window. Other panes remain visible and interactive throughout, and ordinary live output
after restoration never triggers the overlay. A pane that remains mounted while its browser tab or
terminal surface is hidden re-arms the same per-pane cover before buffered output is painted. Newly
created empty terminals skip restoration because they have no retained history to replay.

Dragging pane dividers, the sidebar edge, or the window coalesces the cell
grid: the last frame is stretched to the new pane while you drag, then the
grid and PTY commit once you pause. A real size change already delivers
SIGWINCH, so resize does not walk the program through a one-column detour.
That keeps full-screen programs from stacking garbled frames into scrollback
and from flashing a blank canvas on every tick. (Scrollback already garbled
by an older build is frozen history - programs can only repaint the visible
screen.) TUIs that run on the alternate screen avoid the problem entirely
because their repaints never touch scrollback. Terminals therefore launch with
`CLAUDE_CODE_NO_FLICKER=1` by default, which starts Claude Code in its
fullscreen (alternate-screen) renderer automatically; set the variable
yourself (in a project's runtime env or your shell profile) to override.
Terminal rendering uses the WebGL renderer when available, with a DOM fallback.
OSC 10/11/12 _queries_ are still dropped (they retry with no emulator reply
and flicker); color _sets_ are kept so palettes survive replay. Integrated
PTYs also default `COLORTERM=truecolor` and `COLORFGBG=15;0` so TUIs that
can't query the background still pick a dark truecolor theme.

A terminal's PTY is shared across devices so everyone sees the same text, but
size and layout stay local. Opening or rotating a phone does not resize the
shared PTY or rewrite pane splits on the desktop; the desktop (or last
explicit desktop resize) keeps the column count. When only a shell is in the
foreground, stale mouse/focus tracking in legacy history is reset locally
after buffer replay. Parsed screens preserve the running program's modes. Mouse/focus report
payloads are dropped at the input boundary so cursor movement can't type
escape codes into the prompt. Repeated write failures are reported once
instead of per event, and a terminal whose session the server no longer knows
(e.g. after an app update restarted the server) is respawned automatically on
the next keystroke.

The orchestrator can see which terminals are open, read their current output, and type into a
live pane. See [The orchestrator](./orchestrator.md#terminals).

Integrated terminals disable macOS zsh session restore (`SHELL_SESSIONS_DISABLE`)
so a parent Terminal.app session cannot print "Restored session:" and steal the
keystrokes used to relaunch an agent CLI.

If a terminal was running an agent CLI when the server stopped, the next time
that pane opens it relaunches **that CLI's own session**, not whichever chat
happened to be newest in the directory. Each provider has its own id-specific
resume line, used only when the pane captured a session id while the CLI was
running:

- Grok: `grok --resume <session-id>`
- Claude Code: `claude --resume <session-id>` (session id from
  `~/.claude/sessions/<pid>.json`; Claude no longer keeps the transcript
  open, so open-file probing cannot see it)
- Codex: `codex resume <session-id>`

`--continue` is not used: two terminals in the same project would otherwise
both attach to the latest session. Cursor and OpenCode are recognized as agent
CLIs but have no confirmed session-id resume flag, so they are not auto-relaunched.
If a pane cannot resume (no session id, or the provider has no id-specific
resume command), its leftover TUI history is cleared on the next launch so you
get a fresh shell instead of a garbled alt-screen. A CLI you had already
exited back to a shell is left alone.

## Launching installed CLIs

The **Launch terminals** picker includes Claude, Codex, Grok, Cursor, OpenCode, Antigravity (`agy`),
and Deep Code (`deepcode`) when each is installed, enabled and available in the thread's environment.
Choose the CLIs and the number of panes per CLI. The picker limits selections to the group's pane
capacity and remains scrollable on short screens. Nothing selected opens plain shells.

A background shell command that was stopped during a provider restart is labeled **Stopped** in the
work log. It is not a completed check. Provider startup and an active turn keep the chat's working
indicator and Stop control visible, including when an earlier result arrives during a resumed start.

Batch launches persist their complete split layout before opening shells. Six panes use two columns and three rows, including when restoring separate older groups. CLI launch sends an Enter keystroke (carriage return) so PowerShell executes it instead of entering continuation mode. Recreated terminal views repaint their current snapshot without waiting for another client or new output; attach failures uncover the error instead of leaving the restoring overlay in place.

### Phones and shared terminals

Narrow screens show one terminal at full width with a horizontally scrollable tab bar. Switching back to a wider screen restores the saved split layout; opening a phone view does not rewrite it. The keyboard inset leaves room for the terminal controls and prompt in portrait and landscape. Terminal keys preserve keyboard focus.

When several devices view a terminal, typing or deliberately changing a pane or window size transfers control of its dimensions. Divider drags preview the new layout while held, then commit the terminal grid once after release; unchanged grids do not trigger a host repaint. Automatic cursor-position and capability replies do not transfer control, and passive viewers do not send duplicate replies. History is initially rendered at the server's terminal dimensions before the active client fits it to its pane. Restored output appears after a short parse-settle window, rather than a multi-second loading delay.

### Multiple viewers and terminal recovery

The client receiving real keyboard input or a deliberate layout resize controls the shared terminal dimensions. Other devices render the host grid without resizing the running CLI. Windows panes carry their ConPTY version with the snapshot so the renderer uses the host’s wrapping behavior. New output appends to the displayed buffer even when older scrollback is trimmed.

Codex terminal recovery uses the exact session owned by that pane, including current Codex writer-lock files on Windows. It does not select the latest unrelated session in the same project. Persisted panes start on the host before a viewer opens the thread.

Windows Codex panes stabilize the visible cursor during synchronized redraws. Codex's
animation can briefly leave the Windows output cursor at a painted particle before
restoring the input position. Solla keeps the input caret steady through that gap,
including when viewing Windows from a Mac. Text and ordinary character typing update immediately;
a cursor jump reported only by a synchronized frame settles for up to 80 ms. Ordinary
shells and other CLIs keep their normal cursor behavior.
