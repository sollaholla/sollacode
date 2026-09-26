# Offline thread actions

Archive, restore, delete, settle, and un-settle requests are saved on the client when their device is disconnected. Lists reflect the action immediately: archived threads move to Archive, restored threads return to the active list, and deleted threads disappear. This local view survives a reload while delivery is pending. A queued confirmation means the remote request is still waiting. The client retries when that environment reconnects, using the original command ID. Requests survive a reload; reopen this client to deliver them if it was closed while the device returned.

Opposite pending actions replace each other, so archive followed by restore delivers only restore. An action already sent before the reversal is followed by the newer choice in order. Queued deletion supersedes earlier archive/settlement toggles for the same thread. Offline deletion does not attempt to remove a worktree or clear local drafts before the remote request succeeds.

Custom agents share an internal project but their saved actions are scoped to their dedicated thread. Menus, shortcuts, and action execution respect that ownership. Existing unowned actions in the internal Agents project are retained in storage and hidden because their original owner was not recorded. Ordinary project actions remain shared within their project.

## Sending messages

Messages are saved on the device before the composer clears. Switching threads, collapsing a side chat, or backgrounding the browser does not cancel delivery. Text, image and voice attachments, the selected model, and any thread/worktree creation instructions travel together. The background queue resumes when the environment reconnects; after closing the client completely, reopen the same client to resume. The queue belongs to that browser or app installation and environment, so another device cannot deliver messages that have not reached the server yet.

“Sending” means the server has not yet echoed the saved message. Retries reuse the original message and command IDs so a lost acknowledgment does not create a second turn. Several messages retain their order. A server rejection keeps the message and attachments with Retry and Discard controls; a failure to save locally leaves the draft in the composer. Clearing browser/site storage removes local drafts and undelivered messages.

A reply attached to a Waiting on you card resolves that card only after the server accepts the reply. Ordinary provider approvals retain their existing response flow.
