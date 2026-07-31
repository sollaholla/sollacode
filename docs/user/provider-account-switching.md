# Switching provider accounts

The account control beside the chat composer shows the account reported by the active Codex or
Claude provider. Choose **Switch user** to replace that provider's signed-in account.

Solla Code signs the provider out in the background, starts its native browser login, and shows the
login status over the chat pane. The provider CLI opens the browser itself, so Solla Code does not
open a duplicate browser window. If the window is missing or was closed, choose **Don't see the
browser? Open sign-in link** to reopen it. The project and thread sidebar remains available.

Claude Code may ask you to copy an authentication code from the browser. When it does, the login
overlay shows a paste field and sends the code directly to the waiting Claude Code process. The
code is not saved in account-switch state. You can cancel while authentication is pending.

An active turn is not interrupted. After the provider confirms the new login, Solla Code refreshes
the account status and quota information automatically. The current conversation remains selected,
and subsequent provider work uses the newly authenticated account.

Solla Code does not maintain an account list or store provider passwords. Switching replaces the
account in the selected provider instance's own credential directory.
