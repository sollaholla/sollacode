# Controlling the Desktop Browser from Your Phone

Solla Code's collaborative browser renders on the desktop host — that machine owns the tabs,
cookies, and logins. From any other device you can now _see_ those tabs as near-live frames and
_control_ them with touch: taps, scrolling, dragging, and typing are forwarded to the real page
on the desktop.

There are two ways to use it. Both talk to the same desktop host and require the desktop app to
be running with the tab open.

## Phone Browser (Safari over Tailscale) — no install needed

Open the web app from your phone's browser the way you already do for remote access (see
[Remote Access](./remote-access.md)), then open a thread and its browser panel.

- If an agent already has a browser tab in that thread, you'll see its rendered frame instead of
  the blank pane older builds showed.
- If the panel shows the empty state, enter a URL — it opens as a real tab on the desktop host
  and the frame appears.
- In the remote-control viewer, **Full screen** uses native element fullscreen where the browser
  supports it. On iPhone Safari, where arbitrary elements cannot enter true fullscreen, Solla Code
  switches to an immersive app-level overlay instead: the viewer fills the dynamic webpage viewport,
  hides the normal title/footer chrome, and keeps the remote-control, zoom, and exit controls over
  the stream. Safari's own browser chrome may remain visible because iOS does not let the page hide it.
- **Game Control / FPS mode works on touch Safari without Pointer Lock.** iPhone Safari does not
  implement the Pointer Lock API used by desktop mouse-look. Solla Code therefore treats local
  pointer lock as optional on coarse-pointer devices: once the remote game captures its mouse, the
  on-screen movement/look controls remain active and send relative motion directly to the host.

Interacting with the frame:

| Gesture                                    | What the desktop tab receives                                |
| ------------------------------------------ | ------------------------------------------------------------ |
| Tap                                        | A click at that spot                                         |
| Swipe                                      | Scrolling, in natural touch direction                        |
| Hold ~⅓s, then move                        | A drag (sliders, drag-and-drop)                              |
| Text row + **Type**                        | Trusted keyboard text sent to the last field you tapped      |
| ⏎ / ⌫ buttons                              | Enter / Backspace key presses                                |
| Mouse drag (desktop browsers)              | A drag; use the scroll wheel to scroll                       |
| Keyboard (desktop browsers, frame focused) | Letters, arrows, Enter, Tab, Escape forwarded as key presses |

The frame refreshes about every 2.5 seconds, plus immediately after each input you send. Taps in
the black letterbox bars around the frame are ignored rather than mapped to a page edge.
Inputs are delivered in gesture order, even over a slow relay, and changing tabs immediately starts
a fresh input lane. Text submission re-hit-tests the last tapped position in the same trusted input
turn, so a framework replacing the field's DOM node between the tap and the keys does not redirect
the text. Older captures are discarded when a newer capture finishes first. If typing fails, the
text remains in the row so it can be retried instead of being lost. A failed follow-up frame capture
does not rewrite a successful key delivery as an input failure.
Text is delivered as native character events, preserving Unicode code points and normalizing line
breaks for Chromium. Long strings are not sent as a single character event.

OAuth and other real popup windows become the active remote frame until they close, then the frame
returns to the opener. A held download appears as an approval card with Allow once, Allow always,
and Deny actions on both mobile surfaces.

## Keyboard focus on the desktop

Clicking inside a desktop browser tab gives that tab your next keystroke, including fields inside
embedded frames. Merely hovering does not move keyboard focus. An agent selecting a page field
does not transfer your typing away from the composer; only your own click chooses that surface.
Browser zoom is accounted for when matching agent clicks, so zoomed pages do not falsely report
that an agent was interrupted by human input.

## Native Mobile App

The **Browser** screen (safari icon in a thread's header, or the Browser button on an agent —
enabled once the agent has a thread) shows the same frames with the same touch controls: tap to
click, swipe to scroll, hold-then-move to drag, and a typing row with Enter/Backspace/Tab/Esc.
"New tab" opens a tab on the desktop host. The app needs a build containing this feature; it is
a pure JavaScript change, so an over-the-air update or Metro reload is enough.

## How It Works (and What It Never Touches)

- Frames come from the existing `preview.remoteSnapshot` path: the desktop captures its own
  rendered tab and returns a JPEG over the environment WebSocket, so Tailscale connections keep
  the desktop's cookies and signed-in state.
- Input goes through a `preview.remoteInput` RPC that forwards your gesture into the same
  per-tab, serialized automation operations agents use (`click`, `scroll`, `type`, `press`,
  `drag`). Your phone sends coordinates as fractions of the frame; the server converts them
  against the host's measured viewport at dispatch time, so window resizes can't skew a tap.
- The desktop always keeps rendering its own guest. Remote viewers are only viewers plus input
  senders — nothing about host selection, rendering, or navigation semantics changes when a
  remote device connects.

## Saved passwords for agents

Use the desktop preview's **More > Saved passwords…** menu to add or remove a browser password.
Solla Code normalizes the saved website to an exact origin and accepts HTTPS sites (plus localhost
for development). The operating system encrypts the password before an atomic, owner-only vault
file is written.

An agent first calls `preview_credentials`, which returns matching labels, usernames, and opaque
IDs for the active tab's exact origin. It can then call `preview_fill_credential` with an ID and a
field target. Electron checks the live tab origin again, decrypts in the main process, and sends the
password directly as trusted keyboard input. The secret is absent from the tool arguments and
result, server and WebSocket traffic, activity receipts, and logs. Password management is a
local desktop action; a remote client cannot read or provision the vault.

## Limitations

- **It's frames, not video.** ~2.5s cadence is fine for tapping through flows and filling forms,
  not for scroll-reading. Each input snaps a fresh frame so you see its effect quickly.
- **The desktop app must be running** with the environment reachable; there is no host without it.
- Remote input is treated as automation on the desktop side, so it does not pause an agent
  driving the same tab the way physical input at the desktop does.
- DevTools and CAPTCHA/human-verification challenges stay under the desktop host's enforcement.
