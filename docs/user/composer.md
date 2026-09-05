# Composer

## Revert staged chat settings

Changing the provider, model, effort, service tier, access level, or interaction mode on an existing
chat stages the selection until **Apply changes** is pressed. Right-click **Apply changes** and choose
**Revert** to restore every staged setting to the chat's currently saved configuration. Reverting
does not send a message or alter the prompt and attachments already in the composer.

## Add emoji

The top of the composer shows a single emoji button. Open it to reveal five shortcuts ranked by how
often and how recently they were used on that device, then choose **More emoji** (`…`) for the
searchable picker. Selecting emoji keeps the current drawer open and does not reorder its shortcuts;
the ranking refreshes the next time the shortcut drawer opens. The control fades when draft text
runs beneath it and returns to full opacity on hover or keyboard focus. When **Cut** is available, it
stays in a separate protected space beside the emoji controls.

## Move a draft to another chat

When the composer contains prompt text or image attachments, a **Cut** button appears in its
top-right corner. Cut copies the complete prompt and every attached image, then clears only those
contents from the source composer after the clipboard write succeeds.

Open another chat and paste normally to restore the text at the cursor and attach the copied
images. Provider, model, effort, permission, mode, compaction, and other thread settings are never
transferred or changed.

Attachment transfer is available between chats and same-origin Solla Code windows. Cut stages every
attachment in browser storage before clearing the source, so a route change or renderer reload does
not discard the images. Desktop builds atomically write and verify the prompt text, transfer marker,
and PNG representation before clearing the draft. If either staging or clipboard verification fails,
the source composer remains unchanged. Pasting into another application still provides the prompt
text and first image, but Solla-specific multi-image transfer remains inside Solla Code.

## Reference local files

In the desktop app, drag a file onto the conversation or composer, or copy it in Finder or File
Explorer and paste it into the composer. Images remain uploaded attachments. Videos, documents, and
other file types appear as file-reference chips and are sent to the agent as their exact local path;
their bytes are not uploaded.

Path references are available only when the chat runs in the desktop app's primary, same-computer
environment. A remote, SSH, relay, browser, mobile, or WSL-backed agent cannot read the desktop
client's path namespace, so the composer rejects that reference visibly instead of sending an
unusable path.

After a message is sent, HTTP and HTTPS links open through the app's system-browser integration.
File references open in the owning environment: previewable workspace files use the file panel,
while local videos, audio, documents, archives, and executables are revealed in Finder or File
Explorer. Missing local files report an error instead of failing silently, and remote paths are
never passed to the desktop's local file explorer.

## Interaction and access

Build, Plan, Agent, and the access picker work for Claude, Codex, Cursor, and
Grok. New chats start in **Build**. They keep the current chat's model and
access level, not Agent or Plan. Changing provider or model while a turn is
running stops that turn and starts the next one on the new selection — you do
not have to press **Stop** first. Claude's in-session model switch is not used
for a live turn because it would keep talking on the previous model. Plan mode researches and proposes an approach
without implementing. Switch back to Build, or press **Implement** on the
proposed plan, to apply it. Agent mode keeps working until it finishes or hits
a blocker. Grok has no
separate AI reviewer, so **Auto** auto-accepts file edits the same way
**Auto-accept edits** does; commands still ask unless the chat is in
**Full access**.

## Approve external actions

Agents can pause before consequential external actions such as sending an email or message,
publishing content, making a purchase, or changing an account. The composer becomes an approval
surface containing the exact destination and proposed content. Choose **Approve** to let the agent
continue, or type corrections in the composer; the agent receives that feedback, revises the
proposal, and asks again. The approval covers only the proposal shown in the card.

In Agent mode these action-approval requests are approved automatically. Other interaction modes
keep the explicit approval step. Sending the request pauses the agent until you answer; a second
identical request reuses the same card instead of stacking another.

## Browser download approval

When a preview browser tries to save a file from a site that is not yet trusted, Solla Code holds
the bytes and asks you to **Allow once**, **Allow for this domain**, or **Deny**. The same answers
appear as a composer banner (reachable even if the browser is a floating thumbnail), as an overlay
on the browser pane, and as a desktop notification. The agent waits on your choice and does not
retry the download.

## Voice transcription while away

If dictation finishes after you leave the conversation, the stacked toast above the composer shows a
preview of the transcript, lets you expand the full text, and includes **Send**. Returning to the
conversation puts the transcript in the draft so you can edit it and send from the composer.

## Responsive controls

The composer footer has three responsive layouts. Wide composers show icons and labels. Medium
widths keep every control directly available as an icon-only button with its accessible name and
tooltip. Only extremely narrow composers move secondary controls into the three-dot menu. The
provider/model icon remains directly available in both compact layouts.

## Correct a running turn immediately

Sending a new message while the selected provider is already working routes that message directly
to the exact live turn. Human input uses a priority lane, so it does not wait behind session resume,
reconfiguration, or ordinary queued work. If that native turn ends before the provider accepts the
message, Solla Code keeps the message queued for the next turn instead of sending it to a successor
under a false live-turn identity.

Provider switches and settings changes remain explicit turn replacements. Automated continuation
prompts do not use the human steering lane.

## Send queued Grok messages

Pressing Enter while Grok is already working adds the message to Grok's native prompt queue without
stopping the active turn or its background commands. About a second after the last waiting message
lands, Solla Code sends those queued follow-ups on its own: one message, then its read receipt, then
the next. Sending the whole queue as one insert stalls Grok, so the drain never bulk-inserts.

The empty composer still shows an outlined **Send queued now** action alongside the red **Stop**
action if you want them sent immediately instead of waiting that second. The blue send arrow is not
used for an empty queued composer. Press Enter again, or choose **Send queued now**, to start the
same one-at-a-time drain without the idle delay, still without stopping the current session or its
background work.

While a row is being accepted, the action reads **Sending queued…**. It stays locked until that
message's read receipt lands, then continues with any remaining rows. If the session stops, Grok
rejects the promotion, or a receipt never arrives, the action unlocks and the failure is shown so
the remaining messages can be retried. A completion from another request, thread, or environment
cannot clear the lock. Retrying after a reload, restart, or ambiguous connection failure is safe:
Solla Code reuses durable delivery evidence and asks Grok only about messages that remain
unconfirmed. The action returns when a newer message enters the queue, including after a reload or
reconnect. Web and mobile clients use the same separate queue, Stop, and draft-send actions.

## Stop a chat

**Stop** cancels the current turn, queued deliveries, and pending automatic continuation or recovery for that chat. It also releases a held-send action while leaving the unsent draft available to edit. Messages already in the conversation remain in its history.

Solla first requests a provider interrupt, then closes the provider session. Late provider status events cannot restart the chat, and startup recovery must respect an explicit Stop. Send a new message when you want work to resume. If the provider cannot be stopped, Solla reports that failure in the conversation rather than silently claiming the process exited.

## Queued sends and provider startup

A saved message is queued until the server admits its delivery. Web and desktop show
**Queued for Codex** (or the selected provider), then **Starting Codex** only when
startup has been admitted. A scheduled retry says **Waiting to retry Codex**.

Explicit user sends do not wait for unrelated threads to finish under the server's
background concurrency limits. Sends within the same thread remain serialized.
Automatic continuations, scheduled agent tasks, and recovery work keep their limits;
provider-side rate limits and connection failures can still delay a response.
