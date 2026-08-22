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
