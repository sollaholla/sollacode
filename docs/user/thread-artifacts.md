# Thread artifacts

A thread artifact is a named, revisioned preview published by an agent in an ordinary chat. It can
be structured content, Markdown, an image, a PDF, or a small web bundle. Artifacts remain owned by
the thread and environment that created them.

## Opening artifacts

On web and desktop, open the right drawer. When no surface tab is selected, **Artifacts** appear
expanded at the top of the empty picker, above the surface choices. Selecting an artifact opens its
current revision, and the list hides while any tab is active. The surface add menu still includes an
**Artifacts** submenu. On mobile, choose **Artifacts** from the thread header.
Links shaped like `/<environment>/<thread>?artifact=<artifact>` open the same artifact directly on
web. Opening one of those addresses uses in-app navigation, so the conversation and its running
surfaces stay mounted.

Connected devices request a fresh signed asset URL from the selected host. This means a phone using
the mobile app or the browser through a LAN, relay, or Tailscale connection can render the artifact
without exposing a Mac filesystem path. The link still requires access to that environment.

When a newer revision arrives, an update banner lets you move to it explicitly. A preview already
open stays pinned to its displayed revision until you choose **Use latest**. Archive marks an
artifact inactive without deleting its revision history; **Restore** reverses it.

## Preview boundary

Web bundles run in an opaque, script-only sandbox. Popups, downloads, forms, modal dialogs,
same-origin privilege, and top-level navigation are unavailable. The mobile WebView accepts only
the signed asset subtree on the connected host and blocks new windows and external navigation.
SVG icons are loaded as images from signed host resources; clients never inject their markup into
the application document.

Thread artifacts are different from the custom-agent **Artifact** tab. That older surface is one
schedule, metrics, checklist, table, timeline, cards, or HTML dashboard owned by a named VM agent;
a thread artifact is a revisioned file bundle owned by any thread.
