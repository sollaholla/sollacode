# Opening Settings

Settings shows its header and mobile navigation immediately while a section loads. The first General panel can display a short loading message; it does not wait before presenting the Settings screen. Pressing, focusing, or hovering the sidebar Settings button preloads the route.

This applies to the web client, including mobile Safari, and the Electron client. The separate React Native Settings screen keeps its native navigation.

## Closing Settings

The back arrow in Settings, the drawer's **Back**, and Escape all close Settings and return to the screen you opened it from, however many Settings pages you visited in between. Moving between Settings pages is what the tabs, the drawer sections, and links such as **All projects** are for. When Settings was the first page loaded, closing it opens the workspace.
