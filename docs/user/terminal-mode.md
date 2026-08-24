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

Terminal mode is available on web and desktop. Mobile shows terminal-mode
threads as regular chat threads.

## Rendering notes

Reattaching to a running full-screen program (a TUI) used to show stale or
garbled output until the window was resized. The app now nudges the PTY with a
one-column resize detour when a terminal is first attached or revealed, which
makes the program repaint at the correct size automatically. Live output -
including history the client has prefix-trimmed to stay inside its buffer cap -
is written as a tail, not replayed, so a busy TUI cannot reset the viewport on
every frame. Phone viewers do not resize the shared PTY.

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
Terminal rendering uses the WebGL renderer when available, which removes the
per-chunk repaint flicker fullscreen TUIs otherwise show while scrolling.
OSC 10/11/12 _queries_ are still dropped (they retry with no emulator reply
and flicker); color _sets_ are kept so palettes survive replay. Integrated
PTYs also default `COLORTERM=truecolor` and `COLORFGBG=15;0` so TUIs that
can't query the background still pick a dark truecolor theme.

A terminal's PTY is shared across devices so everyone sees the same text, but
size and layout stay local. Opening or rotating a phone does not resize the
shared PTY or rewrite pane splits on the desktop; the desktop (or last
explicit desktop resize) keeps the column count. When only a shell is in the
foreground, stale mouse/focus tracking left behind by an
exited TUI is reset locally after buffer replay, and mouse/focus report
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
