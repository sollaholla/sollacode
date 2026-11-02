# Accounts and browser profiles

Settings → Access → **Accounts** shows who is signed in to the browser panel, and the logins saved for it.

## Whose browser a tab uses

| Where the tab is                                        | What it shares                     |
| ------------------------------------------------------- | ---------------------------------- |
| Any thread or side chat in a project                    | That project's cookies and cache   |
| An agent's chat, its side chats and its scheduled tasks | That agent's own cookies and cache |
| A thread an agent opened in a project                   | That agent's                       |
| Another computer                                        | Kept on that computer              |

Signing in once in a project holds across all its threads. A new agent starts signed out.

Downloads still go to each thread's own workspace, including its worktree, even though the threads share a browser.

## Signing in

- **Remember this?** After you sign in, a bar on the tab offers **Remember**, **Just this once** and **Never for this site**. Nothing is saved until you choose Remember. If the password has changed, it offers **Update** instead.
- **Saved passwords.** On a site's password page, a bar offers to fill the saved login.
- **Accounts from another project.** On a Google, GitHub, Microsoft or Apple sign-in page, in a project not signed in yet, a bar offers an account already signed in to another project. **Use account** signs this project in too and keeps the two in step, including when you sign out of one.
- **Agents.** Agents are not offered your accounts. To give one an account, use **Use in…** on this page.

Solla Code does not fill Google passwords for agents, and agents don't see them. Google can refuse a sign-in it sees under automation, and that password opens everything behind the account.

Passkeys still don't work in the browser panel. See [the passkey notes in the browser docs](./remote-browser-control.md).

## Signed-in accounts

Each account lists the projects and agents using it. Google's status comes from Google, because its cookies can outlast the session; GitHub, Microsoft and Apple are read from the cookies those sites keep while you are signed in. Solla Code checks once an hour, and when you open this page or press **Check again**.

If a site signs you out, a notice says so with **Sign in again**, at most once an hour per account. **Recent sign-outs** shows when it happened and the cause the browser reported, such as the session expiring or Google ending it.

**Sign out** ends the session at Google and clears that provider's cookies from that profile. Other sites in the profile stay signed in.

## What is kept, and for how long

- **Cookies are encrypted on disk** with your computer's keychain (Keychain on macOS, DPAPI on Windows). A Linux desktop without a system keyring gets weaker protection. Browser Data on this page shows how many profiles are encrypted.
- **Passwords** stay write-only in the vault: no client, agent or log ever receives one. A captured password stays in the desktop app's memory until you answer, or until the tab closes.
- **Removed projects and agents:** their browser data is set aside and deleted after three days.
- **Folders from deleted threads:** set aside after seven idle days, then deleted three days later.

Turning off automatic cleanup in Settings → Storage stops that final deletion. Encrypted cookies can't be read by an older version of Solla Code, so rolling back means signing in again.

## Moving from per-thread browsers

Before 0.1.780 every thread had its own browser, and new threads started from a copy of an old login. The first launch folds those into one profile per project: each project keeps its most recently used thread's browser data, each site's freshest sign-in, and the Google session Google reports as live. Site storage other than cookies comes only from that one thread, so a site that keeps its login there may ask you to sign in once more. The folders it replaces are set aside for three days.
