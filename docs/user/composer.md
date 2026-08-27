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
Grok. Plan mode researches and proposes an approach without implementing.
Switch back to Build, or press **Implement** on the proposed plan, to apply it.
Agent mode keeps working until it finishes or hits a blocker. Grok has no
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
keep the explicit approval step.

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

## Send queued Grok messages now

Pressing Enter while Grok is already working adds the message to Grok's native prompt queue without
stopping the active turn or its background commands. Once Grok acknowledges that queue entry, the
empty composer shows a blue **Send all queued messages now** action. Press Enter again, or choose the
action, to promote every waiting message in send order. This is distinct from the red **Stop** action:
it preserves the current session and background work.

After the batch is promoted the action disappears. It returns only when a newer message enters the
queue, including after a reload or reconnect.
