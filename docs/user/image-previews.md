# Images read by a provider

When a provider reads a raster image, its work-log row can show an inline preview. Muse's “Read image file” and Deep Code's `ReadImage` receipts show the image on web, desktop, and the native mobile app, including receipts already saved in the conversation. Tap or click the preview to enlarge it, then close the enlarged view to return to the conversation.

An enlarged image, and an image open in the file preview, can be zoomed. On a phone or tablet, pinch with two fingers, drag with one finger to look around, and double-tap to zoom in on a spot or back out. On a computer, pinch on the trackpad (or hold Control and scroll), drag to pan, and double-click to toggle. Moving to another image starts it at its normal size.

The preview comes from the file on the thread's host. Relative paths resolve within that thread's workspace or worktree. Connected phones and browsers use a signed URL from the selected environment; they do not try to open the host's local filesystem path. If the file is moved or removed, the row reports that its image is unavailable. The preview displays the file currently at that path, not an archived copy of the image at read time.

Image previews do not turn arbitrary command output or incidental filename mentions into images. An external image outside the workspace must match the exact image path recorded by the tool activity.
