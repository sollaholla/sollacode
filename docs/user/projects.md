# Managing projects

**Settings → Projects** lists every project in your connected environments with what it takes on
disk and how many tokens its chats have used. Rename and remove projects from here, on the web,
desktop, and phone apps.

Other ways in:

- The command palette's **Manage projects** action.
- **Usage and storage** in a project's settings dialog (the project's **⋯** button in the
  sidebar), or **Usage and Storage** in the classic sidebar's right-click menu. Both open that
  project's page directly.
- Searching Settings for "remove project", "storage", "folder size", "token spend", and similar.

## The list

Four totals sit at the top: projects, storage, tokens in the last 30 days, and what those tokens
would cost at API rates. Each row shows the project's folder, its chats, when it was last active,
its storage (with a bar sized against your largest project), and its tokens over the last 30
days. In a narrow browser window, such as a phone's, rows keep storage and leave out tokens;
open the project to see them.

Filter by name or folder, and sort by recent activity, name, storage, or tokens. The orchestrator's
and agents' own projects are marked **Built-in** and always sort last. If you use more than one
environment, each row names the environment it belongs to.

The **⋯** menu on a row renames the project in place or removes it. Refresh (↻, or pull down on
the phone) re-reads the numbers and measures the folders again; what is on screen stays put until
the new numbers arrive.

## A project's page

Select a project to see:

- **Chats, turns, storage, and tokens** at a glance.
- **Token usage**: the last 30 days and all time, a bar per day (hover or tap a day for its
  count), what the tokens were (fresh input, cached input, cache writes, output), and a
  breakdown by provider, using the names you gave your provider instances.
- **Storage**: the folder on disk, chat history, attachments, and artifacts, with how much each
  takes and when the folder was last measured.
- **Chats**: the largest ones (up to 50, or 10 on the phone), with their turns, storage, and
  tokens. On the web and desktop apps, select one to open it.

Rename the project with the pencil beside its name (Enter saves, Escape cancels). On the phone,
edit the **Name** field and tap **Save**.

## Removing a project

**Remove project…** removes the project from Solla Code. Nothing in its folder is deleted: the
confirmation says so first, with the folder's size, so a project rooted at your home folder is no
risk to your files. It then lists what goes: the number of chats (including archived ones), the
history, attachments, and artifacts they hold, and any chat that is working right now and will be
stopped. Removing deletes the project and every one of its chats.

The orchestrator's and agents' projects can't be renamed or removed. Delete or archive their chats
instead.

## What the numbers cover

**Tokens** are counted per turn, as reported by the provider, starting with the first turn that
finishes after you update to the release that added this page. Turns from before then weren't
measured, so they never appear. The page notes the date tracking began.

Claude and Codex report turn usage. A Claude turn includes everything the session used during it,
sub-agents included. Grok, OpenCode, Cursor, Antigravity, Muse, Deep Code, and MCP-bridged providers
don't report per-turn usage to Solla Code yet, so their turns are counted in **Turns** but add no
tokens.

**Cost** is the price the provider reports at API rates. A Claude subscription may cover the work,
in which case you weren't billed this amount. Codex doesn't report a price, so its tokens show
without a cost.

**Storage** is the project's folder on disk plus what Solla Code keeps for its chats:

- **Folder on disk**: everything under the project folder, as the disk counts it (like `du`), on
  the folder's own volume. Hard-linked files count once and symbolic links aren't followed.
- **Chat history**: messages and activity, measured as stored.
- **Attachments**: images and files attached to its chats that are still on disk. The attachment
  retention setting clears these over time.
- **Artifacts**: files the project's chats published as artifacts.

Git worktrees made for its chats live outside the folder and aren't counted. The page says how
many there are.

A large folder, such as a home folder, takes a while to walk, so the environment measures folders
in the background, one at a time, and keeps each result for six hours. Opening the page measures
the folders not measured recently and shows **Measuring…** until each one lands; refresh measures
again now. A folder that holds other projects' folders counts their fresh totals rather than
walking them twice, and the page's total counts each folder once.

On a Mac without Full Disk Access for Solla Code, the measurement leaves out the folders macOS asks
about before an app reads them (Desktop, Documents, Downloads, Movies, Music, Pictures, and other
apps' and cloud drives' data under Library), so it never makes macOS show a permission prompt. A
folder you already work in, because a project lives inside it, is still counted. The page names
what was left out. Folders that couldn't be read are counted as such, so the size is a minimum.

The first start after updating measures existing chat history once, which can make that start
take a little longer on a large install.
