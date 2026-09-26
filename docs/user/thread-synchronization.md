# Loading and reconnecting a conversation

“Catching up…” means the conversation is visible while the client waits for the server to confirm that synchronization has finished. You can continue writing a draft during this step.

If confirmation does not arrive, the client automatically resumes the subscription from the last applied event after roughly 15–20 seconds. Incoming message updates do not postpone that recovery. If the next attempt also fails to finish, the client requests a fresh snapshot. If that one also goes unconfirmed, the client replaces the connection itself. Messages and the unsent draft remain available during recovery; the status clears when the server confirms synchronization.

A dropped network works the same way. When Wi-Fi drops or the phone sleeps, the client closes the dead connection — including a connection that still looks open but has stopped delivering, which a phone on a flaky network can be left with. The conversation then catches up on the next connection without anything from you. If the connection to the conversation ever stops for another reason, the client restarts it from a fresh snapshot about a second later.

This behavior is shared by the web, desktop, and mobile clients. You never need to refresh the page to restart an unfinished synchronization handshake.

## Starting the app

The Solla Code logo covers the app while it starts, and only then. It stays up until the first screen is ready: the app's code, the sign-in check, your workspace (from the last session's cache when there is one), and — when you open a conversation — the conversation view's code. It fades out once and never comes back while the page stays open. A fast start is just the logo. On a slow connection, after a moment a gold bar and one line say which step it is on: "Loading Solla Code…", "Signing in…", "Loading your workspace…", "Opening…".

After startup, anything still arriving says so in place instead of leaving the screen blank: "Loading conversation…", "Opening conversation…", or "Loading your workspace…". If the workspace takes more than about 20 seconds, the logo steps aside and the app shows those in-place states along with its connection status.

If the app's own code has not started after about eight seconds, the page reloads once on its own. It never reloads by itself once its code is running, because that would throw away downloads that are still arriving. Any step that still has not finished after 30 seconds adds a **Retry** button, which shows "Retrying…" while it works. When the app loaded but could not reach the server, it shows "Waiting for the connection" and tries again every few seconds while the page is on screen, and at once when the connection comes back. The server compresses the app's code, so the download after each update is roughly a quarter of its former size.
