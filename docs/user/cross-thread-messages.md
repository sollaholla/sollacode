# Messages from other AI threads

Messages delivered by another agent or the orchestrator appear on the AI side of the conversation, with the sender’s name and a muted “Sent by another thread” label. Select the name to open its source conversation, including side chats and agent threads, in the same environment.

Sender attribution is recorded by the server from the sending tool’s thread identity. It survives reloads and works independently of the selected provider. The receiving provider still receives the message through its existing input path. Older messages without recorded sender information are not relabelled by guessing from their text.

This presentation is shared by the web/desktop and native mobile clients. Deleted source threads follow the app’s existing missing-thread navigation behavior.

Sender messages use a subtle blue tint. The sender name is a chip, and the attribution stays inside the bubble. Opening a sender collapses any visible side-chat panel on the current or destination thread without closing its tabs or stopping its work.

The timestamp, copy control, and delivery receipt stay inside the sender bubble, below its attribution.
