# Orchestrator bug log

Reported defects, what actually caused them, and where they stand. Kept because
several of these were reported more than once under different descriptions and
turned out to share a cause - recording the diagnosis is what stopped them being
investigated from scratch each time.

Newest first.

## Open

_None outstanding; the entries below are fixed but unverified on a real phone._

## Fixed, awaiting confirmation on a phone

### Voice mode hangs after locking the phone

Reported as "locking the phone used to work perfectly with voice mode, but now
it sometimes leaves voice mode hanging so I can't communicate with the
assistant", and separately as beeping with no reply.

**Steps to reproduce.** On a phone, start a voice session and ask a question.
Lock the screen while the answer is playing. Wait past the silence timeout -
five minutes at the default. Unlock and talk. Nothing is heard; the orb still
looks live, and the only way out is stopping and restarting the session.

**Cause.** Three separate things, which is why it was intermittent - which one
you hit depended on where in a turn the screen locked.

1. _The silence timeout fired on evidence it could not collect._ The idle
   watchdog treats room tone above the noise floor as activity, and that level
   is read off `requestAnimationFrame`, which a locked phone stops entirely. The
   platform frequently mutes the capture track as well, so no speech events
   arrive either. From the watchdog's side a live conversation and an abandoned
   one are identical, and it resolved that tie by ending the session.
2. _The microphone was left closed._ With interruption off the session closes
   the microphone while the assistant is audible, and the decision to reopen it
   is made by the same animation-frame loop. Lock the phone mid-answer - the
   ordinary case, since that is when you put it away - and the microphone stays
   closed with nothing running that would ever open it again.
3. _Returning tore down a connection that was recovering._ The visibility
   handler added for this reported a dropped transport for any peer state that
   was not `connected` or `connecting`. `disconnected` is transient by
   specification and is exactly what an unlocking phone reports while ICE
   re-runs its checks, so coming back killed sessions that were about to
   recover on their own.

**Fix.**

1. The silence timeout is deferred, not cancelled, while the page is hidden.
   Locking a phone mid-conversation is deliberate use - it is the
   walk-with-headphones case - not abandonment. The elapsed silence is kept, so
   a session that really was idle ends the moment the screen comes back rather
   than never.
2. The microphone is handed back when the page hides, and a slow interval
   reconciles the half-duplex gate off the clock rather than off the animation
   frame. The level meter stays the primary path; it is simply no longer the
   only one.
3. The visibility handler defers to the same classification and the same grace
   the connection handler already used, instead of keeping a second opinion
   about which states mean "gone".

Separately, the waiting tone can no longer sound indefinitely: after 45 seconds
with no answer the session gives the floor back, reopens the microphone and
returns to listening. A capture track the platform mutes - a lock, an incoming
call - is now detected and announced rather than waited on silently.

### The sidebar did not collapse when voice started

**Cause.** The sidebar context carries two independent open states: `open` for
the docked sidebar and `openMobile` for the sheet that replaces it on a narrow
screen. The auto-collapse set only `open`, so on a phone - the one place the
sidebar most needs to get out of the way - it did nothing at all. The reports of
this arriving from a phone browser were correct and the desktop behaviour
masked it.

**Fix.** The collapse now writes whichever state is actually in force, and
restores the same one.

### The assistant interrupts itself and cuts off mid-sentence (mobile)

Reported as "it keeps interrupting and stopping the conversation mid-speech,
making it unusable."

**Cause.** The realtime session is configured with `interrupt_response: false`
so the client, not the server, decides when to cut a reply short - but with
`create_response: true` still set, the server _creates a second response_
whenever its voice-activity detector fires. On a phone the orchestrator's own
voice comes back through the speaker, trips that detector, and a second response
begins while the first one's audio is still playing. Its audio then plays over
the tail of the sentence in progress.

**Fix.** A response that begins while the previous one is still audible, and
that the client did not ask for, is cancelled (`response.cancel` only - clearing
the output buffer would cut off the very sentence being protected). Independent
of any device detection, so it holds even where the echo heuristics do not.

**Why it took several attempts.** Both echo protections - closing the microphone
during playback, and this cancellation - asked the same question: "is the
assistant audible right now?" That was answered solely from
`output_audio_buffer.started`, so any browser that does not send that event
disabled both of them at once, silently, leaving the symptom identical to having
no fix at all. The question is now answered from the measured level of the
remote audio track as well, with the server event still preferred when it
arrives. `isAssistantAudible` is a pure function with its own tests for exactly
this reason: the failing case is the hardest to reproduce and the easiest to
regress.

### The assistant repeats itself, rewording the same point (mobile)

Reported separately, **same cause as above**: the duplicate response answers the
question that is already being answered, so the same point arrives twice in
different words. Fixed by the same cancellation.

### It answers things the user never said (mobile)

Reported as: said "hi, can you hear me?" once, and the transcript filled with
"OK." turns nobody spoke, plus a reply about a camera.

**Cause.** Acoustic echo - the assistant's voice reaching the microphone and
being transcribed as the user. Browser echo cancellation is requested and loses
on a phone speaker, and client-side filtering can only judge an echo after it has
been uploaded and already acted on.

**Fix.** The microphone is closed while the assistant speaks. This existed but
was behind a setting that defaults to on, so it never engaged; it is now forced
on touch devices with a small viewport, where the speaker is centimetres from the
microphone. Desktops keep barge-in and the setting.

### The listening period ends while the user is still thinking

**Cause.** `silence_duration_ms` at 1,100ms. Ordinary speech carries longer
pauses than that - reaching for a name, working out a phrasing.

**Fix.** Raised to 1,800ms. The two failure modes are not symmetric: waiting too
long adds a beat before the reply, cutting in too early loses the end of the
sentence and answers the wrong question.

### The transcript cannot be scrolled, and does not follow new messages

**Cause.** The full-screen listening overlay's backdrop is deliberately
click-through (`pointer-events-none`) so the thread underneath stays readable.
The transcript list inherited that, so a touch drag passed straight through it.
There was also no auto-scroll, and only the last six entries were rendered.

**Fix.** Pointer events re-enabled on the list, `overscroll-contain` so the drag
does not chain to the page, an auto-scroll to the newest entry, and the whole
conversation rendered rather than a six-entry tail.

### It claimed it could not send to a working thread

The user was then able to send that message by hand.

**Cause.** Hallucination. No tool description, instruction, or guardrail says a
busy thread cannot be sent to - the model invented the restriction.

**Fix.** The instructions now state the opposite explicitly, and generalise it:
never claim a limitation you have not hit; attempt the call and report what the
tool actually says. Inventing a restriction is worse than a real failure because
it stops work the user could have had.

### A voice change only applied to the next session

**Cause.** The voice is minted with the session token and genuinely cannot change
mid-conversation, so the tool reported "next time" - which can be hours away.

**Fix.** Changing the voice now tears the live session down and immediately
restarts it, so the new voice is heard at once. The tool tells the model to keep
its acknowledgement to a few words, since the reconnection cuts off anything
longer.
