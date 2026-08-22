# The orchestrator

The orchestrator is a single agent that spans every thread in the workspace. It has its own pinned
thread in the sidebar, and it can be spoken to - the same conversation either way, since spoken
turns are recorded into that thread as ordinary messages.

It manages threads; it does not do their work. It reports what each thread is doing, routes work to
the right one, changes their settings, and stops them when asked. It never writes code itself.

## Tools

The orchestrator calls tools the same way any thread does, as often as it needs and several within
one turn, rather than running a fixed script. Which tools it may call is decided by
**Settings → Orchestrator → Authority**:

| Tool                        | Authority     | What it does                                                        |
| --------------------------- | ------------- | ------------------------------------------------------------------- |
| `list_threads`              | Read only     | Every thread with its status, open terminals, and its model         |
| `describe_thread`           | Read only     | One thread in detail: model, effort, access mode, and why it failed |
| `read_thread`               | Read only     | The messages in a thread, grouped into numbered turns               |
| `search_threads`            | Read only     | Searches what threads have said, and the errors they recorded       |
| `get_orchestrator_settings` | Read only     | Its own live provider, model, voice, language and authority         |
| `get_runtime_state`         | Read only     | Environments, reachability, and thread counts by state              |
| `get_usage`                 | Read only     | Provider quota - the Providers tab figures - and its own voice cost |
| `open_website`              | Read only     | Opens a named site in your browser, optionally on a search          |
| `list_project_files`        | Read only     | A project's layout - folders and files                              |
| `read_project_file`         | Read only     | Reads a text file from a project                                    |
| `find_project_files`        | Read only     | Finds files by name or partial path                                 |
| `search_project`            | Read only     | Searches file contents, with file and line numbers                  |
| `run_command`               | Read only     | Runs a command on your computer and reads the output back           |
| `list_terminals`            | Read only     | Terminals currently open, and which thread each belongs to          |
| `read_terminal`             | Read only     | The current output of a terminal pane                               |
| `send_to_thread`            | Send messages | Posts a message into one thread, as if you had typed it             |
| `write_to_terminal`         | Send messages | Types into a live terminal, as if you had typed there               |

Ordinary chats have the same three terminal actions on `thread_terminals`, so the
main chat can list, read, and type into open panes without going through the
orchestrator.
| `create_thread` | Send messages | Starts a new thread for unrelated work and sends its first message |
| `create_side_chat` | Send messages | Opens a side chat off a running thread, sharing its context |
| `rename_thread` | Send messages | Gives a thread a clearer title |
| `settle_thread` | Send messages | Marks a thread finished; changes nothing else |
| `update_thread_settings` | Full control | Changes a thread's model, effort, access permissions or mode |
| `interrupt_thread` | Full control | Stops a thread's in-flight turn |
| `approve_proposed_plan` | Full control | Approves the plan a thread is waiting on, so it starts building |
| `create_project` | Full control | Links a folder you already have as a project |

Every tool takes a `reason` - a short phrase saying why it was called. That reason is what makes the
call log readable afterwards.

## Reading and searching threads

`read_thread` returns what a thread actually said - the messages, newest last,
grouped into turns numbered from one so "in the second turn" is something the
orchestrator can say out loud. Ask it what a thread found, decided or concluded
and it reads rather than guessing from the thread's status, or sending the thread
a message asking it to repeat itself. `includeActivities` adds the tool calls and
events behind those turns.

`search_threads` looks for a word or phrase across the workspace, or inside one
project or thread. Matches come back with the thread they came from, the turn,
and a snippet centred on the match rather than the opening of the message.

Both are read-only, so they work at any authority. Long messages are truncated
and streaming messages are skipped - a half-written message changes under the
reader.

A search covers at most 15 threads in one call. When there are more, the answer
says how many were not searched instead of reading as though it had looked
everywhere; narrowing to a project searches the ones you care about.

### Errors are searchable too

Failures are recorded as thread activities, not as messages, so a search that
only read messages could never find an error unless the agent happened to also
write it out in prose. Messages and activities are searched as one index, each
carrying its own timestamp, so an error is found **at the moment it occurred**
and comes back interleaved with the messages around it in the order things
actually happened.

Error matches are marked: they carry `isError`, `source: "activity"`, and the
activity's kind (`provider-error`, and so on) in place of a message role. The
orchestrator is told to lead with them and say when they happened.

## Reading your projects

The orchestrator can read the projects you have open, so it can answer questions about the code
from what it actually says rather than guessing. It can list a project's layout, read a text file,
find a file by partial name, and search file contents for a string.

These go through the same server RPCs the editor uses, which resolve every path against the
project's own workspace root and reject anything that escapes it, along with binaries. So the reach
is "files inside a project you already opened", not the disk. They are available at **read only**
authority, since they change nothing.

`run_command` can look around the machine. File writes still go through a thread that owns the
work. Terminals the user already has open are visible separately: see [Terminals](#terminals).

## Looking around your computer

`run_command` runs a command and reads the output back, so the orchestrator can find things out for
itself instead of telling you to go and check. Pipes, globs and redirection all work - it is a real
shell, not a restricted subset.

**Read-only is asked of it, not enforced.** An allowlist of "safe" commands was tried and removed:
the line between reading and writing is gray in practice - a build that writes a cache, a tool whose
read mode is a flag - and a list strict enough to mean anything blocked most of what the feature is
for. The model is told to stay read-only and trusted with it, the same way it is trusted with every
other tool.

What _is_ refused is a short list of things that cannot be undone: formatting a disk, writing to a
raw device, `rm -rf` at a filesystem root, shutting the machine down. That list is not a permission
boundary - it is there because commands arrive by voice, and a mis-transcription of one of those is
not recoverable. Deleting a build directory is not on it.

Commands are stopped after twenty seconds and their output is truncated, so a command that prints
everything gets cut off rather than read out at length.

## Terminals

Every thread can have one or more terminals open - an agent CLI such as Claude, Grok or Codex, or
an ordinary shell. `list_threads` now reports those panes on each thread so the orchestrator can
see that something is running in a terminal without opening the pane itself.

- `list_terminals` lists every open pane, or those on one thread.
- `read_terminal` returns the visible text currently on screen. Color codes are stripped and a
  long buffer is truncated to the tail. This does not start a terminal that is not already there.
- `write_to_terminal` types into a live pane as you would, and presses Enter unless asked not to.

Writing needs **send messages** authority, the same as posting into a thread. Listing and reading
are available at **read only**. The orchestrator will not open a new terminal; if nothing is open
it says so.

Ask it what Claude is doing in a pane, or to type a reply into that CLI, and it uses these rather
than guessing from the chat timeline or starting a separate `run_command`.

## Linking a folder as a project

`create_project` adds a folder you already have to Solla Code, so threads can be started in it.

It only ever _links_: if the path is not there, it fails and says so rather than creating an empty
directory. It also refuses anything that is not an absolute path, because a bare folder name from
speech has no location and guessing one is how a project ends up pointed at the wrong directory -
ask it to find the folder first, which it can now do with `run_command`. It asks you to confirm out
loud before adding anything.

## Approving a plan out loud

`approve_proposed_plan` accepts the plan a thread is waiting on, so you can say yes rather than
going to find the thread. It sends exactly what the approve button sends, and forces the turn out of
plan mode - under the thread's own mode you would get a second plan, since the thread is in plan
mode precisely because it just proposed one.

It asks you to confirm out loud first, and it is deliberately at full authority: the plan is yours
to accept, and this exists so you can delegate saying yes, not so it can decide for you. Ask it to
describe the plan first if you have not seen it.

## Threads waiting on a plan

A thread that has proposed a plan has stopped, and it will not move until you approve it - nothing
in the workspace can approve on your behalf. That state used to be reported as "waiting on a
proposed plan", which is true and tells you nothing: you still had to go and open the thread to find
out what you were being asked to agree to.

Ask about such a thread now and `describe_thread` reads the plan itself, reporting what it proposes,
how many steps it lists, and that you are the one holding it up. The orchestrator says what the plan
is and offers to read the steps rather than reciting them at you.

The plan is only fetched for a thread that is actually stopped on one, and if it cannot be read the
orchestrator says so instead of guessing at what it proposed.

A thread only counts as waiting on a plan while it is actually stopped in Plan mode **and the
latest turn itself is the one holding an unimplemented plan**. Having a plan in the thread's
history is not a wait. A leftover plan after the user left Plan mode, started building, or
continued on a later turn used to keep reporting "waiting on proposed plan". Those threads now
read as working or idle. Approval prompts and input requests are different: those are raised by
a turn that is still in flight, so they stay visible while the thread works.

## Opening a website

Ask it to open, pull up or put on a site and it will - "open YouTube", "pull up the map for Kings
Cross", "look that up on GitHub". The page opens in your normal browser, in a new tab or window,
exactly as if you had clicked a link.

This is the only thing the orchestrator can do outside the app, and it is deliberately the narrowest
capability that answers "put that on":

- **A named site, not an address.** It chooses from a fixed list - YouTube, Google, Google Maps,
  GitHub, Wikipedia, Stack Overflow, npm, MDN, Spotify, Gmail, Google Calendar, Google Drive. A
  hostname it invents cannot be opened, because there is nowhere to put one.
- **A page, not a program.** It cannot launch an application, run a command, install anything, or
  read or write a file. On the desktop the request goes through the same allow-listed path a clicked
  link takes, which accepts `https` and `http` and nothing else.
- **Names are matched by sound**, so "you tube" and "YouTube" are the same request. Where two sites
  sound equally alike it asks rather than guessing.

Because it only opens a page, it is available at **read only** authority. Sites that support search
take your words with them; the ones that do not open their home page, and the orchestrator says so
rather than leaving you wondering why nothing was searched.

In a browser rather than the desktop app, opening a page from a voice command is not a click, so
your pop-up blocker will usually stop it. When that happens the orchestrator says the browser
blocked it rather than claiming it opened - allow pop-ups for the site, or use the desktop app,
where it goes through the same path a clicked link takes.

## Side chats

`create_side_chat` opens a side conversation off a thread that is already running. It forks that
thread, so the side chat inherits the conversation as it stands right now and can be asked about
work in progress - while the parent keeps running, undisturbed.

Use it for a question or a tangent about what a thread is doing. `create_thread` is for genuinely
separate work; confusing the two loses the context that makes a side chat useful.

The side chat inherits the parent's model, access mode and interaction mode. Because forking
touches the parent's provider session, an uncertain target is confirmed before anything is forked

- though an unambiguous one is not.

## Interruptions

Talking over the orchestrator cuts it off. Deciding _when_ that has really
happened is the hard part, and there are two separate failure modes.

A noise is not speech. A cup set down is louder than any voice, so loudness is
deliberately not evidence; what separates them is shape. The client watches the
microphone for a fraction of a second and only interrupts on sound that sustains
and is still going when it looks again.

Its own voice is not speech either. On a phone speaker - or leaking headphones -
the orchestrator's output comes back into the microphone, and echo is _perfectly_
sustained, so the shape test alone could never catch it. That is why this showed
up on mobile as the model cutting itself off after a word or two. Every frame is
now compared against what is playing at that instant: the microphone has to be
meaningfully louder than the speaker for it to count as a person. On a machine
whose echo cancellation works the assistant barely registers, so nothing changes.

The same echo reaches the transcriber, which turns half-heard output into stray
one- and two-word "user" messages. Those are dropped while the orchestrator is
speaking - except for the words someone genuinely says alone ("stop", "wait",
"yes", "no", "quiet", "cancel"), so cutting it off out loud still works.

### When it answers itself

If the orchestrator keeps replying to things you did not say, its own voice is
reaching the microphone and the server is transcribing it as you. Nothing on the
client can fully prevent that: browser echo cancellation is requested and still
loses on a phone speaker, and every filter here can only judge the echo _after_
it has been uploaded and already turned into a user turn.

The cure is to stop sending it: the microphone is closed for as long as the
orchestrator is speaking, so its voice cannot reach the server at all.

**On a phone or tablet this is automatic.** The speaker is centimetres from the
microphone there, so echo is the normal case rather than the exception, and
leaving it to a setting meant the runaway conversation happened first and the
setting was found afterwards. Any touch device on a small screen closes the
microphone while the orchestrator speaks whatever the setting says. A laptop with
a touchscreen is not included - it has a mouse, real speakers, and a better
microphone.

Everywhere else it is yours to choose: turn off **Let me interrupt by talking
over it** under **Settings → Orchestrator → Interruptions**. The cost either way
is barge-in - you can no longer cut it off by talking, though saying "stop" still
works once it has finished, and the stop button always does.

If you would rather never be interrupted mid-answer, that same switch is what you
want. The orchestrator then always finishes its sentence, and saying "stop" or
"quiet" - which goes through `end_voice_session` rather than the barge-in path -
still silences it.

## Ending the conversation out loud

Say "that's all", "goodbye" or "stop listening" and the session closes; say
"quiet" or "stop talking" and it stops mid-sentence but keeps listening. Neither
needs a button, which is the point when the phone is in a pocket.

A spoken goodbye is allowed to finish before the microphone closes - cutting it
in half read as a crash - and counts as deliberate, so nothing reopens the
session afterwards.

## Coming back when work finishes

The orchestrator often says it will report back. If the microphone closed on
silence before the work landed, nothing was ever going to keep that promise:
completions are only spoken while a session is live, and the world diff advanced
past them regardless. You were left waiting on an answer that had already
arrived.

**Come back when awaited work finishes** (on by default, under
**Settings → Orchestrator → Usage**) closes that gap. When work the orchestrator
dispatched finishes while voice is off, it reopens the session and leads with why
it is talking - that the thing you asked about is done - before giving you the
answer.

Reopening a microphone unprompted is not a small thing, so all of these hold at
once:

- only work **the orchestrator itself dispatched** and owed you an answer on -
  never every thread in the workspace;
- only when the **silence timeout** closed the session. If you stopped voice by
  hand, it stays stopped; that is a decision, not a lull;
- only within **30 minutes** of the request, because hearing about something from
  three hours ago is worse than not hearing about it;
- at most **three** consecutive wake-ups without you saying anything in between,
  so a thread flapping between states cannot turn the microphone into a strobe.
  Speaking to it resets that budget.

Every decision not to wake is recorded in **Recent tool calls** with its reason
(`not-awaited`, `expired`, `not-closed-by-timeout`, …), so a wake-up that did not
happen can be explained rather than guessed at.

## When a thread fails

A failure announcement carries the provider's own error text, verbatim, plus the
classification the provider gave it (an authentication failure and a usage limit
need different answers, and the message alone does not always make clear which
one it was). The orchestrator is told to say the actual reason - naming the
limit, credential, file or command the error names - not "an error occurred".

That error also rides along on every thread listing and description, so asking
"what's wrong with the Vera Medical thread?" is answerable without opening it.
Alongside it comes **when the failure was recorded**, both as a timestamp and as
something speakable - "about 3 hours ago" - so the orchestrator can tell a fresh
break from one you already dealt with without reading the thread. A timestamp it
cannot parse is omitted rather than voiced.
It is carried whenever the provider recorded one, not only while the thread still
reads as failing: a thread that failed and then went idle is exactly the one
asked about afterwards.

If a thread failed and no error message was recorded, the orchestrator says that
plainly instead of inventing a reason.

## How it decides

The orchestrator acts on your behalf rather than walking you through options. Given a request, it
works out where the work belongs and does it:

- **Related to something already running** → sent to that thread. One piece of work stays in one
  thread instead of being scattered across several.
- **Unrelated to every open thread** → a new thread, with a title it writes itself.

It asks only when the context genuinely does not decide the answer - two threads fit equally well,
several projects exist and none was named, or it would be guessing at something it cannot see. A
question it could have answered by calling `list_threads` is one it should not be asking.

## Naming a thread out loud

You do not have to say a thread's exact title. References are matched against the thread's title,
the project it belongs to, and that project's folder, with punctuation, casing and filler words
ignored - so "the Solla Code thread", "solla code" and "Solla Code" all reach the same place, and
"t3 fork" finds `t3-fork`. Partial names work ("Vera Medical" finds "Vera Medical intake API"), as
do mildly mis-transcribed ones.

Stronger matches always beat weaker ones: an exact title wins over a similar-sounding one, so
adding a thread named "Rovers" never steals traffic from "Rover".

If a name genuinely fits more than one thread, the orchestrator asks - and tells them apart by
project and by what each is doing, rather than reading out ids. If it fits nothing, it says so and
offers the closest open threads instead of failing silently.

## When you get asked to confirm

Confirmation is reserved for things that are actually hard to undo. You are asked when:

- a thread's turn is about to be **interrupted**;
- a settings change would **stop a turn in progress** - which is what applying a model, effort or
  mode change to a thread that is currently working means;
- a change would **widen an agent's access permissions** - always, even with
  **Confirm destructive actions** turned off;
- the thread you named genuinely **matches more than one** open thread, or was only a weak match.

You are _not_ asked to confirm sending a message, renaming a thread, or changing a model or effort
level on an idle thread. Those are reversible and disturb nothing, and confirming them every time
was friction rather than safety.

### Seeing what it called

**Settings → Orchestrator → Recent tool calls** lists the last 25 calls of the running session: the
tool, its stated reason, the outcome (`ok`, `needs-confirmation` or `error`), and how long it took.
The same lines go to the browser console prefixed `[orchestrator]`.

## Telling similar threads apart

Every thread reports the project it belongs to, and `list_threads` and `describe_thread` include it.
This is what makes three threads all called "Vera Medical" answerable: the orchestrator can say
"the one in Vera Medical intake, currently working" instead of listing identical titles.

You can also fix the underlying problem - ask it to rename one. Titles are validated (trimmed,
whitespace collapsed, capped at 80 characters) so a dictated sentence cannot become a sidebar entry.

## Marking a thread settled

Ask it to mark a thread finished and it records exactly that - the settled state, nothing more. The
thread stays in the sidebar, in the same place; nothing is hidden, archived or removed. Asking it to
undo reverses the flag.

Settling an idle thread happens immediately, since that is the cleanup being asked for. The one
check is when the thread is **still running**: calling live work "finished" is a contradiction, so
it reads that back first. Note the server refuses to settle a thread for a short grace period after
new work is sent to it, so settling immediately after sending something can fail - the orchestrator
reports that rather than claiming success.

If the thread belongs to a computer that is offline, the orchestrator queues the settle or
un-settle request and says that it will be applied when the computer reconnects.

## Changing a thread's settings by voice

`update_thread_settings` changes the model, provider, thinking effort, access permissions, and
plan/agent/normal mode of a thread that is already running. Only the fields you name change.

Requests are validated against the provider catalog before anything is dispatched, so asking for a
model that is not installed, or an effort level a provider does not offer, comes back with the
reason and the valid values rather than failing silently later.

**How a change reaches the thread is not the same for every field:**

| Change                           | How it lands                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| Access permissions               | **Immediately** - the provider session restarts from its resume cursor              |
| Model, provider, thinking effort | Recorded against the thread, then **applied by a short turn** the orchestrator runs |
| Plan / agent / normal mode       | Recorded against the thread, then **applied by a short turn** the orchestrator runs |

Leaving agent mode is the one exception to the last row: queued follow-up turns stop right away.

The distinction matters because recording a new model only _caches_ it - the provider keeps talking
to the old one until a turn establishes a session. Being told "your model will change next time the
thread runs" is not what anyone means by switching a model, so the orchestrator applies the change
itself: it sends a short settings-update turn that makes the thread adopt it. You asked for the
switch, so it does not ask again before doing so.

On a thread that is **already working**, that same turn stops the one in progress - otherwise the
update would queue behind work still running under the old settings. That consequence you did not
ask for, so it is read back to you first.

Access-permission changes never force a turn. They reach the live session through their own command,
so stopping work to deliver something that had already arrived would be pure loss.

If you want the old deferred behaviour - record the change and leave it for whenever the thread next
runs on its own - say so, and the orchestrator passes `applyNow: false`.

### Why a voice model change used to revert

A turn carries the model it should run under, and the server persists whatever it receives. The
orchestrator applied the change, then sent the "Settings updated" marker turn using the model read
from its cached view of the thread - which, because that view only refreshes when the server
broadcasts back, was still the _old_ model. So the marker turn told the server to use the previous
model, and the server dutifully wrote it back, undoing the change.

The visible symptom was two contradictory lines in the transcript: a request saying
`provider → mcpBridge, model → chatgpt-browser` immediately above a "Conversation settings updated"
separator still naming the old model. The access mode and mode shown alongside it were correct,
because the server reads those from the thread itself rather than from the turn.

The turn now carries the model that was just chosen, explicitly, rather than re-reading a cache that
cannot have caught up yet.

## Checking which model the orchestrator is using

The voice session's provider, model and voice are read from settings when the session **starts**.
Changing **Settings → Orchestrator → Voice provider**, **Model** or **Voice** restarts a live
session so the change is heard immediately. It does not affect typing to the orchestrator.

Grok Voice (xAI) is a second backend next to OpenAI Realtime. Setup, environment variables and
limitations are in [Grok Voice for the orchestrator](../integrations/orchestrator-grok-voice.md).

Three ways to check, in increasing order of directness:

1. **Ask it.** "What model are you running on?" calls `get_orchestrator_settings`, which reports the
   model the live session was actually started with - not the saved setting. If the two differ it
   will say so and tell you to stop and start voice.
2. **Settings → Orchestrator → Model.** The status line under the field reads
   `Live session is running on <model>` when they agree, and
   `Live session is still running on <model>. Stop and start voice to switch to <other>  -  no app
restart needed.` when they do not.
3. **The server log.** Every session start writes one line naming the model that was actually
   minted:

   ```
   grep "orchestrator realtime session minted" ~/.solla-code/userdata/logs/server.trace.ndjson
   ```

   It carries `model`, `voice`, `configuredModel` and `authority`. `model` is what the session runs
   on; `configuredModel` is what settings said at that moment. This is the authoritative record -
   the other two read from the same value.

So: change the model, stop voice, start voice, then use any of the three to confirm the new one took.

## When a thread finishes

Completion announcements are built from the thread's own closing message, not a canned line. The
orchestrator tells you what the agent actually did, names concrete outputs it mentioned - files,
branches, PRs, URLs - and suggests a next step.

It distinguishes how the work ended: a turn that was interrupted or ran out of room is announced as
incomplete rather than finished, and an errored turn is announced as an error. If the thread is now
blocked on an approval or a question, it says that instead of implying the work is done. When the
closing message cannot be read in time, it says so rather than guessing.

## Usage and spend

**Settings → Orchestrator → Usage** shows what the voice orchestrator has cost: today, this month,
and all time, with daily and monthly breakdowns.

Token counts are exact - they come from the Realtime API's own per-response `usage` block, so they
are what this app actually consumed. Costs are **estimates**: those counts multiplied by a
hand-maintained rate table (published rates as of August 2026), so they may not match your OpenAI
invoice, and a model with no known rate shows tokens with no dollar figure rather than a guess.

This is what _this app_ spent, not your account total. OpenAI's organisation usage endpoints need
an Admin key, and the key configured here is a normal API key.

You can also just ask. `get_usage` reads both halves out loud: your providers' remaining quota -
the same figures the Providers tab shows, so the two can never disagree - and the voice cost above.
Ask how much is left, whether you are near a limit, when a window resets, or what talking to it
costs. It leads with the window closest to running out rather than reciting every number, and it
always says a dollar figure is an estimate.

"Heard" is audio you sent; "Spoken" is audio the orchestrator produced, which bills at roughly twice
the rate - it is usually the largest line. History is stored on this machine, keeps 180 days of
daily rows, and can be cleared from the same panel.

## Locking your phone

A voice session survives the screen going off. The wake lock stops the screen _timing out_ during a
conversation, but it cannot stop you deliberately locking the device, and locking it mid-conversation
is a normal thing to do - it is the walk-with-headphones case.

Two things change while the screen is off, both because the browser stops giving the page animation
frames. The silence timeout is **deferred**: it cannot measure room tone with no frames, so rather
than guess it waits until the screen is back. The elapsed silence is kept, so unlocking a phone that
has genuinely been quiet ends the session immediately rather than granting it a fresh five minutes.
And the microphone is handed back as the page hides, because the echo protection that closes it runs
on those same frames and would otherwise leave it closed with nothing able to reopen it.

Coming back to a connection that really died is treated as a drop and reconnects on its own, with the
rising three-note tone when the microphone is open again. A connection that is merely re-establishing

- which is what a phone reports for a second or two after unlocking - is left alone to recover.

If the platform takes the microphone away entirely, which happens on a lock or an incoming call, you
hear the connection-lost tone rather than nothing: talking to something that cannot hear you is worth
interrupting for. The rising tone follows when it comes back.

## Stopping automatically

**Stop listening after silence** (on by default) closes the voice session after 30 seconds in which
neither you nor the orchestrator has spoken. A realtime session bills for streamed silence, and an
open microphone left running is a cost as well as a surprise. The timeout is configurable from 5 to
600 seconds.

Silence means silence, not "no messages for 30 seconds". The countdown is checked against what the
microphone is actually hearing, so a long sentence with no turn boundary in it keeps the session
open. Anything the microphone picks up above the noise floor counts, as does the orchestrator
speaking and a turn being generated - the session only closes when all of them have been quiet for
the full window. Cutting off someone who was still talking was the failure mode this replaced.

### It never speaks first into a silence

The Realtime API can be told to answer a long pause on its own - it commits the silence as an empty
turn and generates something to prompt you to keep talking. That is a phone-call behaviour, and it
is deliberately off here and sent as off on every session rather than left to the API's default.
When you stop talking, the orchestrator waits; it does not fill the gap. The only thing that happens
after a long silence is the session closing, above.

## Speech

The spoken language is pinned by **Settings → Orchestrator → Language**, which anchors both what the
orchestrator speaks and how your audio is transcribed. Without a pin the model picks a language from
ambiguous audio and can open a conversation in the wrong one.

The pin has to be in force before you are heard, which is why the microphone stays muted for the
moment between the connection opening and the server confirming the settings. WebRTC needs the
audio track in its opening offer, so media starts flowing before there is any channel to send
settings over; a word spoken into that gap was transcribed with no language hint and answered under
default instructions. A short "hi" is exactly the kind of ambiguous audio a transcriber invents a
language for, and it came back in Japanese. The session now waits for the acknowledgement - and
opens the microphone regardless after three seconds, so a server that stops acknowledging costs a
pause rather than a dead microphone.

Turn detection waits out mid-sentence pauses rather than answering the first gap, and ignores brief
noise, so a cough or a keyboard does not start a turn. Transcripts that contain no letters of the
pinned language are dropped - transcribers emit stock foreign phrases when handed silence, and those
would otherwise be recorded as things you said.

On models that support it (the `gpt-realtime-2` family), the session asks for high reasoning effort.
The orchestrator's hard problems are deciding which single thread owns a request and whether a
settings change is safe, and both are worth the small extra latency.

## Background noise

Two things kept the orchestrator answering the room rather than you.

A turn that contains no words is now discarded silently instead of being answered. Voice detection
fires on energy, not on language, so a door or a cough opens a turn and the server generates a reply
to it - which came out as "I didn't catch that" every time anything happened nearby, the most
irritating possible response to a noise, because it demands you answer something you never started.
The filter is deliberately conservative: only a transcript with no letters or digits at all, or a
bare `[BLANK_AUDIO]`-style marker, counts as noise. A one-word answer is always answered.

**Filter background noise** (Settings → Orchestrator → Microphone) goes further, running your
microphone through a noise gate before it is sent, so fans, traffic and typing are held down between
the things you say. It is off by default because it sits in the outgoing audio: if you start
sounding clipped, or quiet words go missing, turn it off. Your browser's own speech isolation is
separate and always used where it exists.

## Sounds

The voice session marks what it is doing with short tones, so you can tell where you are without
looking at a screen.

| Sound                | When                                                         |
| -------------------- | ------------------------------------------------------------ |
| Rising two-note      | The microphone just opened. Start talking.                   |
| Short click          | The first words of what you are saying came back as text.    |
| Falling two-note     | Your turn closed and was accepted.                           |
| Soft repeating pulse | Waiting for the answer. Stops the moment it starts speaking. |
| Low falling pair     | The connection dropped.                                      |
| Quick low double     | You spoke over a reply and were not heard. Say it again.     |
| Rising three-note    | The connection is back **and the microphone is open again**. |

Two rules keep them from becoming noise. Nothing plays over the orchestrator's own voice - the
answer is its own feedback. And nothing plays while you are talking, with two deliberate exceptions:
the click, which exists precisely to confirm mid-sentence that your words are getting through, and
the connection-lost tone, because talking to something that cannot hear you is worth interrupting
for.

The waiting pulse cannot sound forever. If no answer arrives within 45 seconds it stops, the
microphone reopens and the session goes back to listening - a wait that never ends is a wait
something dropped, and pulsing over it just makes the session unusable without saying why.

The waiting pulse is only for _your_ question. Background work - a thread finishing, housekeeping
tool calls - never triggers it; otherwise every routine event would sound like an alarm.

It also covers the "let me check that…" pause. An answer that opens with a sentence and then goes
away to run something used to leave dead silence: you hear a finished-sounding utterance, assume the
floor is yours, and talk into a session that is not listening. The pulse now runs through that gap
too, and the floating orb shows a spinner rather than a microphone for the same reason.

The not-heard tone replaces what used to be an error box. Talking over a reply that is already
being generated is not a fault and there is nothing to dismiss - it is answered in the register that
works mid-conversation, a sound rather than a dialog.

## Where the voice view appears

While a session is live the app shows a full-screen surface with the orb and the transcript - **on
handhelds only**. A phone has nowhere else to put that state: no sidebar, no thread list, and the
small orb is invisible at arm's length.

On a desktop it is deliberately absent. Covering the whole app to announce that the microphone is
open takes away the work you are talking _about_, and the desktop app already answers the same need
with the floating bubble - a small always-on-top window that says the same thing without owning the
screen. A desktop browser gets neither; the orb in the sidebar is enough with the app in front of
you.

The test is form factor, not app-versus-browser: a touch pointer and a small viewport. A narrowed
desktop window stays a desktop window, and a laptop with a touchscreen is not a handheld.

The sidebar follows the same rule, for the same reason. It only ever moved so it would not sit under
the overlay, so it now collapses **only where the overlay actually appears** - on a handheld, while
a session is live. On a desktop nothing covers the screen, so nothing takes your navigation away.
Opening the orchestrator to type at it is an ordinary thread visit and never moves the sidebar
anywhere.

Both decisions read the same predicate, deliberately: a sidebar that hid itself for an overlay that
never arrived is exactly the bug that comes of keeping two copies of the rule.

## When voice will not start

Every reason voice refuses now says which reason it is, in the message itself. That was not always
true: a failure during setup used to be reported as a bare "could not start", or as nothing at all,
which sent more than one debugging session looking at the app when the problem was elsewhere.

The one worth calling out is **an account with no credits left**. It is the most confusing
failure in the set, because everything else keeps working right up until the last step - settings
save, the key validates, the session token is even issued successfully - and only the session itself
refuses. OpenAI points at `platform.openai.com`; Grok Voice points at `console.x.ai`. Nothing in
the app can work around it; the account needs credits.

The same applies to the other actionable cases: the orchestrator being disabled, no API key
configured, a refused voice, and rate limiting. Whatever the API said is passed through rather than
replaced with one sentence that fits every cause and helps with none.

### Where you see it

As a toast, on every platform.

It used to appear nowhere at all. The listening view looks like it reports failures, and on a
handheld it would be the obvious place - but that view only renders while a session is actually
running, and a session that failed to start never gets there, so the message it was written to show
could not be reached. On a desktop the view is not rendered in the first place, which left a tooltip
on the microphone button as the only trace: readable only if you already knew to hover over the
control that had just appeared to do nothing.

A session ending the way you configured it - "voice stopped after 30 seconds of silence" - is shown
as an ordinary notice rather than an error, because that is the feature working, not failing.

## When the network drops

A voice session cannot survive losing Wi-Fi: the connection fails and nothing arrives again, while
your microphone stays open and you carry on talking to something that is no longer there.

The session now notices and reconnects on its own - four attempts, roughly 0.6s, 1.5s, 3s and 6s
apart. A dropped session cannot literally be resumed (its token is spent), so this starts a fresh
one and carries on; for a brief drop it is close to invisible. You hear the low falling pair when it
goes, and the rising three-note only once the microphone is genuinely open again, so that sound
always means "you can talk now" rather than "the network came back".

If all four attempts fail, it stops and says so rather than holding an open microphone against a
dead network. Stopping the session yourself is never treated as a drop and is never chased.

Two things it deliberately does **not** treat as a drop:

- **A brief `disconnected`.** WebRTC reports this whenever connectivity checks lapse, and on a phone
  - especially over a VPN - it happens routinely on a connection that is perfectly fine. It is given
    a few seconds to recover before anything is torn down, and usually recovers.
- **A connection that never came up.** A session that fails while it is still being negotiated has
  not dropped; that is a startup failure, and it is reported as one with the actual reason. Treating
  it as a drop is what made voice fail to start at all with no error shown - the teardown looked
  like a deliberate stop, so the real error was swallowed.

## The floating bubble

**Settings → Orchestrator → Floating bubble** puts an always-on-top orb on screen. It grows when you
speak and when the orchestrator speaks, and can be dragged anywhere. Tapping it starts or stops
recording; the small button in its corner opens the orchestrator thread.

While a session is live the sidebar collapses on its own, and the app dims behind a full-screen
listening surface - an open microphone should not be a 56-pixel dot you have to look for. The
surface is click-through: you can keep reading the thread underneath while you talk about it. Both
undo themselves when the session ends.

## On your phone

The phone app has the orchestrator as a full screen of its own: one large button, the state in
words, and the transcript. It is the web client's voice view hosted in the app, so the microphone
and the audio are on the phone - which is the arrangement that makes it usable on a walk with
headphones - while the work happens on the Mac it is connected to.

Open it from **Settings → Orchestrator → Open Orchestrator**.
