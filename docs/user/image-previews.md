# Images read by a provider

When a provider reads a raster image, its work-log row can show an inline preview. Codex's **Image view**, Muse's “Read image file”, and Deep Code's `ReadImage` receipts show the image on web, desktop, and the native mobile app, including receipts already saved in the conversation. A shortened path label does not hide the preview: it uses the full recorded file path. Tap or click the preview to enlarge it, then close the enlarged view to return to the conversation.

Collapsed image calls show a compact thumbnail row. When a group of previous tool calls is collapsed, its hidden images appear beneath the group’s disclosure button, so you can find them without expanding the log. The row stays one line high, shows at most six tiles, and adapts to the available width. **+X more** opens an **Images viewed** gallery with filenames and scrollable previews. Selecting a thumbnail in either place opens the usual enlarged image viewer.

The compact row only appears while its corresponding call or group is collapsed. Expanding a call restores its larger inline preview. Thumbnail space is reserved before images load, and overflow images are loaded as you browse the gallery rather than all at once in the conversation.

Thumbnails load a small copy of each image, made on the host machine, rather than the whole file: a row of full-size screenshots took over a minute on a phone's data connection. The whole image loads only when you open it. A host that can't make small copies (macOS makes them with its built-in `sips`) sends the original instead.

An image that can't be shown, because its file is gone and no copy was kept, or because it can't be decoded, isn't displayed at all: it leaves its thumbnail row, a row left with none disappears, the larger preview in an opened tool call is left out, and the enlarged viewer skips it.

An enlarged image, and an image open in the file preview, can be zoomed. On a phone or tablet, pinch with two fingers, drag with one finger to look around, and double-tap to zoom in on a spot or back out. On a computer, pinch on the trackpad (or hold Control and scroll), drag to pan, and double-click to toggle. Moving to another image starts it at its normal size.

## Moving between images

An enlarged image opens among every image in the conversation, oldest first: images attached to messages, images a provider read, browser snapshots, and the pages the token optimizer rendered. Swipe left for the next image and right for the previous one. The image follows your finger, and the next one slides in from that side; a short drag settles back, and a quick flick is enough. On a computer, use the arrow buttons beside the image or the Left and Right arrow keys. The caption under the image shows its place, such as **shot.png (3/12)**.

A swipe only moves between images while the image is at its normal size. Once you zoom in, dragging pans instead; zoom back out to swipe on. Dragging with a mouse never changes the image.

Images are fetched as you reach them, one ahead of the one shown, so opening the viewer in a long conversation does not download every image in it. An image that turns out to be gone leaves the gallery: found while preloading, the swipe skips it; found on screen, the next image takes its place. In the phone app, one already swiped past stays in place with a note that it's gone, because removing it would move the page you're on. On web and desktop, moving past the newest image wraps around to the oldest; the native mobile app stops at either end.

Images in a draft, in the composer or a review comment, page through that draft's images. An image opened from a file link in a reply shows on its own.

The preview comes from the file on the thread's host. Relative paths resolve within that thread's workspace or worktree. Connected phones and browsers use a signed URL from the selected environment; they do not try to open the host's local filesystem path. The preview prefers the file currently at that path. If the file is moved, removed, or cannot be decoded, it falls back to an image retained in the tool result, when available. Otherwise the thumbnail indicates that the preview is unavailable.

Image previews do not turn arbitrary command output or incidental filename mentions into images. An external image outside the workspace must match the exact image path recorded by the tool activity.

## Browser snapshots

When an agent takes a snapshot of a page in the in-app browser (`preview_snapshot`), its row shows the page it captured the same way: a thumbnail while collapsed, a larger preview when expanded, and the usual enlarged viewer on click or tap. Snapshots join the thumbnail row of a collapsed group and its **Images viewed** gallery, labelled **Browser snapshot**. This works for every provider, on web, desktop, and the native mobile app. The picture shows the page as the agent saw it at that moment, not as it is now.

The server keeps each snapshot's picture as an attachment file instead of inside the conversation, so threads stay quick to load and a picture is only downloaded when its row is on screen. Like every attachment, it is removed after the attachment retention period (48 hours by default, under **Settings → General → Background work**); an older snapshot then reads **Preview unavailable**. Codex snapshots saved before this change were cut short when they were stored and show no picture, rather than the top of the page over grey.

## When every image breaks at once on desktop

The desktop app loads images through its own network process. That process can restart while the app keeps running, after a crash or when the system stops it. Before 0.1.725, every image then failed without reaching the host, and stayed broken until you quit and reopened the app: Electron leaves the app's image loader tied to the process that is gone. The app now notices the restart and loads images over a fresh connection.

Image links are signed and expire after an hour. Before 0.1.725, coming back to a conversation hours later could reuse links that had already expired, so its older images showed as broken until the next refresh, up to half an hour later. Returning to a conversation no longer reuses expired links.
