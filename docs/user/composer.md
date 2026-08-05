# Composer

## Move a draft to another chat

When the composer contains prompt text or image attachments, a **Cut** button appears in its
top-right corner. Cut copies the complete prompt and every attached image, then clears only those
contents from the source composer after the clipboard write succeeds.

Open another chat and paste normally to restore the text at the cursor and attach the copied
images. Provider, model, effort, permission, mode, compaction, and other thread settings are never
transferred or changed.

Attachment transfer is available between chats and same-origin Solla Code windows. Cut stages every
attachment in browser storage before clearing the source, so a route change or renderer reload does
not discard the images. If that staging fails (for example because disk storage is unavailable),
the source composer remains unchanged. Pasting into another application still provides the prompt
text, but Solla-specific multi-image transfer remains inside Solla Code.

## Responsive controls

The composer footer has three responsive layouts. Wide composers show icons and labels. Medium
widths keep every control directly available as an icon-only button with its accessible name and
tooltip. Only extremely narrow composers move secondary controls into the three-dot menu. The
provider/model icon remains directly available in both compact layouts.
