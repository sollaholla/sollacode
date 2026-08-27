# Storage and conversation cleanup

Solla Code keeps active conversation history, tool activity, browser state, artifacts, and chat
attachments in the environment that owns the thread.

## Deleted conversations

Deleting a conversation removes its projected messages, activities, plans, sessions, browser
state, runtime state, work obligations, checkpoint diffs, and event payload history from the
database. A minimal deletion marker remains so connected and reconnecting clients can agree that
the conversation was deleted. Thread artifacts, terminal history, and recorded attachment files
are removed by the same deletion workflow.

Database pages freed by deletion are reused by SQLite. Solla Code does not run an automatic full
`VACUUM` during startup because compacting a large database would block launch and temporarily
require substantial additional disk space.

## Attachment retention

**Settings → General → Attachment retention** controls how long chat attachments remain on disk.
The default is **48 hours**. Cleanup runs in the background at startup, whenever the retention
value changes, and once per day. Files whose modification time is at least the configured age are
permanently removed; regular conversation text remains until its thread is deleted.

The attachment directory is walked incrementally so a large store does not have to be loaded into
memory. Closing or deleting a thread removes only the attachment paths recorded by that thread and
does not scan the complete attachment store.

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
