# Opening Settings

Settings shows its header immediately while a section loads. The first General panel can display a short loading message; it does not wait before presenting the Settings screen. Pressing, focusing, or hovering the sidebar Settings button preloads the route.

This applies to the web client, including mobile Safari, and the Electron client. The separate React Native Settings screen keeps its native navigation.

## Closing Settings

On a computer, the back arrow, the drawer's **Back**, and Escape all close Settings and return to the screen you opened it from, however many Settings pages you visited in between. When Settings was the first page loaded, closing it opens the workspace.

On a phone held upright, Settings opens on a list of sections by category. The back arrow in a section returns to that list, and the back arrow on the list closes Settings.

## Where things are

| Category  | Sections                                                      |
| --------- | ------------------------------------------------------------- |
| App       | General, Appearance, Sound & voice, Keybindings               |
| AI        | Providers (including models), Agents, Orchestrator            |
| Workspace | Projects, Source Control, Archive                             |
| Access    | Connections, Devices, Credentials, and Permissions on desktop |
| System    | Storage, Diagnostics                                          |

## Search

Search in Settings finds any setting by name, by its section, or by words you might use for it, and jumps to the row. **Search** in the sidebar (Cmd+K or Ctrl+K) finds settings too, along with commands, projects and your conversations.

Conversation search looks through what you wrote and each agent's final answers, in every chat on every connected computer. Archived chats are included and listed last, under **Archived threads**.
