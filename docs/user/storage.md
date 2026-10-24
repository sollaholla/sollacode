# Storage and conversation cleanup

Solla Code keeps active conversation history, tool activity, browser state, artifacts, and chat
attachments in the environment that owns the thread.

## Start a storage cleanup thread

Tap the free-space number beside the disk icon in the phone browser's top bar or a remote
thread's header. The popup shows the machine's free and total space and a **Create cleanup
thread** button.

The button starts a dedicated thread in a **Storage cleanup** workspace on the machine whose
storage is displayed. The host creates and checks its own maintenance folder and uses its
configured Utility AI model, independently of your current project. Missing project folders
and offline projects on other devices cannot redirect the cleanup. Your conversation and draft
stay intact.

New cleanup threads start in **Auto** approval mode, including their first turn. An AI reviewer
approves routine actions; actions that need your approval still ask. You can change the approval
mode from the cleanup thread’s composer.

The button is disabled while that host is disconnected. The app opens the cleanup thread only
after the host accepts the request and this device receives the new project and thread. The
popup shows **Opening thread…** while those updates arrive, so a slow connection cannot send
you to an unrelated new draft. Closing the popup does not cancel opening the created thread.
Retrying a failed connection uses the same request to avoid duplicate threads. If the maintenance
folder has been removed, the host recreates it.

The cleanup request asks the agent to inspect disk usage, remove only confirmed disposable
files, and report the space recovered. It explicitly preserves login cookies, signed-in sessions,
saved credentials, personal files, source code, active work, and live Solla Code databases.
Opening the popup alone does not start a cleanup.

## Loading long conversations

Opening a conversation loads its newest 300 messages first. The server also returns the total
message and activity counts plus opaque cursors, so the client can show how much older history
exists without transferring or rendering its contents. Scrolling near the top or using **Load
earlier messages** fetches the next bounded page. Provider context and **Export chat** still use the
complete durable conversation; this windowing changes only what an interactive client loads.

## Deleted conversations

Deleting a conversation removes its projected messages, activities, plans, sessions, browser
state, runtime state, work obligations, checkpoint diffs, and event payload history from the
database. A minimal deletion marker remains so connected and reconnecting clients can agree that
the conversation was deleted. Thread artifacts, terminal history, and recorded attachment files
are removed by the same deletion workflow.

A long conversation's history is removed a batch at a time, so deleting one doesn't hold up
other threads. If Solla Code quits or restarts before a deletion finishes, it finishes that
deletion the next time it starts.

Database pages freed by deletion are reused by SQLite. Solla Code does not run an automatic full
`VACUUM` during startup because compacting a large database would block launch and temporarily
require substantial additional disk space.

## Archived chat retention

**Settings → Archive → Delete all archived chats** deletes the currently listed archives
across connected environments after one confirmation. Active chats are kept. Each environment
deletes its own archive in one request, up to the newest archive you were shown, so a chat
archived after you opened the list stays. If some chats cannot be deleted, the rest are still
deleted and the notice says how many went and why the others stayed. Environments running an
older Solla Code server are cleaned one chat at a time.

Enable **Settings → General → Auto-delete archived chats** to permanently delete chats
48 hours after they were archived. This setting is off by default and applies to the
primary environment, including chats archived from web, desktop, or mobile. Each environment
owns its own setting. Disabling it stops future automatic deletions.

Cleanup runs on server startup and once per minute while the server is running, using the
same deletion workflow as manual deletion. If the server is offline at the deadline, cleanup
runs after it starts again. Restoring a chat before cleanup keeps it; archiving it again starts
a new 48-hour period. Already deleted chats cannot be restored.

## Attachment retention

**Settings → General → Attachment retention** controls how long chat attachments remain on disk.
The default is **48 hours**. Cleanup runs in the background at startup, whenever the retention
value changes, and once per day. Files whose modification time is at least the configured age are
permanently removed; regular conversation text remains until its thread is deleted.

The attachment directory is walked incrementally so a large store does not have to be loaded into
memory. Closing or deleting a thread removes only the attachment paths recorded by that thread and
does not scan the complete attachment store.

## Automatic cache and update cleanup

**Settings → General → Automatic storage cleanup** is enabled by default. It applies to the
desktop host's primary environment and can be switched off from desktop, web (including a phone
browser), or native mobile Settings → Automatic storage cleanup. The desktop checks the saved
setting before each deletion; unreadable settings stop cleanup. This setting is separate from chat,
attachment, and browser-recording retention.

- **Browser caches:** one minute after launch and daily thereafter, clear inactive HTTP and compiled
  code caches older than 7 days, then the oldest eligible caches until their combined size is under
  2 GiB. Profiles used by an open browser view and caches modified within 24 hours are protected,
  so the budget is a soft limit. Legacy profiles on disk are included. Electron's cache-only APIs
  preserve cookies, saved logins, credentials, Local Storage, IndexedDB, Service Workers, and
  Session Storage. Cache files are downloaded or compiled again as needed.
- **Mac updates:** after the replacement app passes its health check, retain the newest five Solla
  installers per architecture and format in the installer directory, plus the installer just used.
  Older packages and their blockmaps must be at least 24 hours old and not open in any process.
  Temporary extraction copies are removed by the updater on exit. Unknown filenames, development
  builds, and other directories are left alone.
- **Mac Codex runtimes:** two minutes after launch and daily thereafter, retain the newest three
  standalone versions per platform plus the current, explicitly configured, and running versions.
  Cleanup stops while Codex's installer lock is open or a process inventory is unavailable. Recent
  versions, unknown builds, conversation logs, and provider configuration are preserved.

The desktop log records cache/runtime cleanup results; the updater log records retired installers.
Both include the measured change in available disk space, which can also reflect concurrent work.
Desktop browser cache cleanup applies on macOS, Windows, and Linux; installer/runtime pruning
currently requires macOS. Remote servers and project asset-generation output are not swept.

## Browser recordings, screenshots, and downloads

The desktop app keeps preview-browser recordings, saved screenshots, and files an agent downloaded
without a save prompt in `browser-artifacts` inside its state directory. A background sweep runs a
minute after launch and hourly after that. It deletes files older than 7 days, then the oldest files
first until the folder is under 2 GiB. Files modified in the last 24 hours are never deleted, so a
download in progress or a recording an agent just reported stays put. Files a person allowed into a
project folder are not in this directory and are never swept.

## Preview snapshots in provider history

`preview_snapshot` returns the page's text, interactive elements, and a screenshot. The accessibility
tree it includes is limited to about 48 KB (nodes Chromium marks as ignored are dropped, and the
result says how many nodes were left out), and the page is sent once instead of twice. Providers keep
every tool result in their own history, so an unbounded snapshot repeated across hundreds of calls
used to grow a single provider session to hundreds of megabytes.

## Stored tool diagnostics

Solla Code limits individual strings in newly stored raw tool results to 16,384 characters,
including Claude SDK results and MCP output. This limits duplicated diagnostic data in the
conversation database; tool inputs, normal chat messages, and the results delivered to the
provider remain unchanged. Large raw result fields in the work log may be truncated. This
limit does not shrink an existing database file or delete files in agent workspaces.

## Export

**Export chat** writes the complete conversation to JSON. In the desktop app, Solla Code reveals
the exported file in Finder immediately. The web app downloads the same JSON through the browser.
Export no longer creates a persistent background-task record.

## Recovering from a stalled provider or full computer

When a thread fails because its provider did not start, the computer ran out of storage, or the
host ran out of memory, the error banner offers **Fix with AI**. This starts a background Agent-mode
thread in a dedicated project named after the computer, rooted directly in the user's home folder.
The current chat and workspace stay open.

The repair thread always uses approval-required access. Its operating instructions require it to
measure the computer first, distinguish an app retry defect from general host pressure, act only on
exactly identified orphan processes, and limit storage cleanup to measured reproducible caches.
It must not broadly kill processes or remove projects, documents, browser profiles, local models,
credentials, device images, archives, or the live Solla Code database. The thread finishes with
before-and-after measurements and an exact list of every process and path it changed.

A provider startup control timeout is terminal for that attempt: Solla Code closes the failed
worker and does not recreate it in a long retry loop. Explicit upstream retry signals retain their
normal bounded retry behavior.
