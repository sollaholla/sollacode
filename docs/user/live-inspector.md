# Live Inspector

The Live Inspector shows what every agent is doing, as it happens, on one screen: you watch the work
rather than read about it afterwards. The orchestrator is always a chat button away, at the bottom
center.

## Opening it

- **Sidebar:** the screen icon beside **Orchestrator**.
- **The orchestrator's thread:** the screen icon in its header.
- **Command palette:** **Open Live Inspector**.
- **Shortcut:** **Cmd+Shift+L** on macOS, **Ctrl+Shift+L** elsewhere. Press it again, or Escape, to
  close it and go back to where you were.
- **Phone:** **Live** at the top of the orchestrator screen, or **Settings → Orchestrator → Live
  Inspector** in the phone app.

## What it shows

**Cards, grouped by project,** for every thread that needs you or is working, and for threads that
finished or stopped in the last ten minutes, so a finish stays up long enough to read. Settled and
snoozed threads are left out, the same ones the sidebar sets aside, even if one still holds a plan or
an error. Each project
gets a line naming it and what its threads are doing ("1 needs you · 2 working"); the project with
the most urgent thread comes first.

A card is meant to be read at a glance:

- its status, and for a working thread how long it has been at it: _Working · 12m_;
- the thread's title;
- the agent's own latest words, in quotes: what it says it is doing, or what it did;
- what it is doing this second, such as _Running_ `pnpm test`. A thread waiting on you shows what it
  is asking for instead.

The card lights up once whenever its thread makes a move. Threads that need you come first:
_Needs your approval_, _Waiting for your answer_, _Has a plan for you_. Then _Working_, _Stopped on an
error_, and _Finished_. Up to twelve cards show; the rest are counted below them. The arrow on a card
opens that thread.

**Moves** are written in plain words:

- what a tool did, and to what: _Ran_ `pnpm test`, _Edited_ `…/src/app/main.ts`, _Searched_ a
  query, _Used_ some other tool;
- what the agent said, in quotes, as it writes it;
- messages sent to the thread, by you or by another thread;
- background tasks starting, finishing, or failing;
- questions and approval requests;
- errors, provider switches, and context compactions.

A tool's output is never shown, only what it was asked to do. Long commands keep their first line,
long paths their last three parts, and a leading `cd` is dropped.

**Everything, as it happens** is a timeline of the latest sixty moves across all threads, newest
first, with the time of each. The header counts how many threads are working and across how many
projects, how many need you, and how many are quiet; settled and snoozed threads are not counted.

## Talking to the orchestrator

Click the chat button at the bottom center, or press `/`, and type. Enter sends; Shift+Enter starts a
new line; Escape closes the box. The message goes to the orchestrator's thread exactly as if you had
typed it there, so it can route work, report on threads, or stop one.

The conversation runs at the bottom of the screen like subtitles: what you sent, until the
orchestrator starts answering, then its reply as it is written. A reply stays up for two minutes after
it finishes. If a message can't be sent, the words stay in the box so you can try again.

## Good to know

- Moves come from the server, which keeps the latest 160 in memory. After the app restarts the
  timeline starts empty and fills as agents work; the cards are right straight away, because thread
  status comes from the threads themselves.
- With several environments connected, their moves are merged by time.
- Each new move slides in once and each card lights up once per move. Nothing animates while nothing
  happens, and the system's reduced-motion setting turns the motion off.
- In the phone app, the app's own header closes the inspector, and cards don't open threads.

See also [the orchestrator](./orchestrator.md).
