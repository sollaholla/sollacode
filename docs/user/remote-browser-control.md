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
- While an agent drives a tab, its blue cursor is drawn on the frame where it last pointed or
  clicked, and the tab's icon in the panel strip turns into the agent cursor (bright while the
  agent works, dimmed while it waits for you). Frames refresh every second while an agent is
  working in the tab, instead of every 2.5 seconds.
- In the remote-control viewer, **Full screen** uses native element fullscreen where the browser
  supports it. On iPhone Safari, where arbitrary elements cannot enter true fullscreen, Solla Code
  switches to an immersive app-level overlay instead: the viewer fills the dynamic webpage viewport,
  hides the normal title/footer chrome, and keeps the remote-control, zoom, and exit controls over
  the stream. Safari's own browser chrome may remain visible because iOS does not let the page hide it.
- **Game Control / FPS mode works on touch Safari without Pointer Lock.** iPhone Safari does not
  implement the Pointer Lock API used by desktop mouse-look. Solla Code therefore treats local
  pointer lock as optional on coarse-pointer devices: once the remote game captures its mouse, the
  on-screen movement/look controls remain active and send relative motion directly to the host.

Interacting with the frame uses the same touch vocabulary as the remote-control viewer (see
[Touch actions in remote control](./remote-touch-actions.md)):

| Gesture                                    | What the desktop tab receives                                       |
| ------------------------------------------ | ------------------------------------------------------------------- |
| Tap                                        | A click at that spot                                                |
| Swipe                                      | Scrolling, in natural touch direction                               |
| Hold still ~0.4s                           | The radial menu: **Scroll**, **Drag**, **Right-click**, **Hold**    |
| Menu → Scroll, then move                   | Scrolling, as a swipe does, while your finger stays down            |
| Menu → Drag, then move                     | A drag from the held spot, dropped where you lift (sliders, maps)   |
| Menu → Right-click                         | The page's right-click menu, drawn on your phone (see below)        |
| Menu → Hold → Left / Right hold            | That button held at the spot until you lift (up to 5 seconds)       |
| Two-finger pinch / pan                     | Zooms and moves the picture only; nothing reaches the page          |
| **Keyboard** button (touch devices)        | Raises your phone's keyboard; letters, Return, and ⌫ go to the page |
| ⏎ / ⌫ buttons                              | Enter / Backspace key presses                                       |
| Mouse drag (desktop browsers)              | A drag; use the scroll wheel to scroll                              |
| Right-click (desktop browsers)             | The page's right-click menu, drawn in the viewer                    |
| Keyboard (desktop browsers, frame focused) | Letters, arrows, Enter, Tab, Escape as key presses; paste as text   |

Tap the field on the page first, then type: text goes to whatever the desktop tab has focused.
The keyboard stays up while you tap from field to field. Characters typed while an earlier batch
is still travelling are sent together in the next one, in order with any Return or ⌫ presses.
Predicted words and pastes go as typed. Keyboards that build a word before committing it, like
Android's Gboard or a Japanese input method, send the word when it is finished; until then ⌫ edits
that word on your phone rather than the page.

Because the frame is a picture refreshed on request, not a live stream, Drag and Hold are sent
whole when your finger lifts: you see the result in the next frame, not while you move.

Scrolling turns a mouse wheel on the desktop tab at the spot where your finger first touched, so
whatever sits under it scrolls: a chat list, a sidebar, or a document pane scrolls on its own, the
way it would under a desktop mouse, even when the page itself does not scroll. The mouse wheel in a
desktop browser's viewer works the same way, at the pointer.

A Right hold never opens a menu on the desktop screen. If the page would show its right-click menu
after the hold, that menu is dismissed; use **Right-click** to see and use it.

**The page menu.** A right-click on the desktop tab would open its menu on the desktop screen,
where you can't see it. Instead, the viewer shows a menu for what you right-clicked:

- a link — open it in a new desktop tab, open it on this device, or copy its address;
- an image, video, or audio — open it in a new desktop tab or copy its address;
- selected text — copy it, or search the web for it in a new desktop tab;
- a text field — undo, redo, cut, copy, paste, and select all, as the page allows;
- anywhere else — back, forward, reload, and copy the page address.

Copy and paste use **your device's** clipboard, never the desktop's. Paste asks your browser for
the clipboard; where it refuses (common over plain HTTP), open the keyboard and paste from it.
Only web links are opened; a script link can be copied but not run. If the page draws its own
right-click menu, that menu appears in the next frame and you tap it like anything else.

The frame refreshes about every 2.5 seconds, plus immediately after each input you send. Taps in
the black letterbox bars around the frame are ignored rather than mapped to a page edge.
Inputs are delivered in gesture order, even over a slow relay, and changing tabs immediately starts
a fresh input lane and drops keyboard text not yet sent. Older captures are discarded when a newer
capture finishes first. A failed follow-up frame capture does not rewrite a successful key delivery
as an input failure. Text is inserted atomically into the focused page field, preserving Unicode
and normalizing line breaks for Chromium without borrowing the desktop's keyboard focus.

OAuth and other real popup windows become the active remote frame until they close, then the frame
returns to the opener. A held download appears as an approval card with Allow once, Allow always,
and Deny actions on both mobile surfaces.

## Hearing the tab

When a page in the tab you are viewing plays sound, your phone plays it too. A speaker button in
the control strip under the frame turns tab sound on or off for that device, and the choice is
remembered. Browsers only let sound start after a tap, so the first tap on the page (pressing
play on a video, say) is what lets it through. If the tab is already making sound, the speaker
reads **Tap to hear** until you tap. On an iPhone, tab sound plays even with the silent switch on.

Sound is only sent while it is worth hearing. Your device listens only while sound is on, the
tab is the one on screen, and the page is in the foreground. The desktop sends audio only while
someone is listening and the page is actually making sound. It stops about two seconds after the
page goes quiet. A playing tab costs roughly 12 KB/s; a quiet or unwatched one costs nothing.
The sound is Opus-encoded and arrives about a fifth of a second behind the desktop.

While a remote device listens, the desktop keeps playing the tab's sound as well. Listening needs
Safari 26 or later on iPhone and iPad, or a current Chrome, Edge, or Firefox. On an older browser
the speaker button is greyed out and says so. The native mobile app does not play tab sound yet.

## Keyboard focus on the desktop

Clicking inside a desktop browser tab gives that tab your next keystroke, including fields inside
embedded frames. This holds for clicks made through Remote Control too: the panel briefly
flickering out of focus as the page takes the keyboard does not hand your typing back to the
composer. When the browser panel is really hidden, the keyboard returns to the app about a second
after your last click. Merely hovering does not move keyboard focus. An agent selecting a page field
does not transfer your typing away from the composer; only your own click chooses that surface.
Long text edits stay inside the target page without borrowing the composer’s native keyboard
focus. New human input cancels pending input commands immediately. A text edit already running
finishes atomically inside that page, so no remaining characters can spill into your composer.
Browser zoom is accounted for when matching agent clicks, so zoomed pages do not falsely report
that an agent was interrupted by human input.

Opening an agent browser tab returns its tab ID once the browser is available, even while the
page is navigating. Optional viewport and page diagnostics have short deadlines; a slow page
does not need to finish those checks before the open result can return. Known human-verification
gates remain in effect.

## Native Mobile App

The **Browser** screen (safari icon in a thread's header, or the Browser button on an agent —
enabled once the agent has a thread) shows the same frames with the same touch controls: tap to
click, swipe to scroll, hold-then-move to drag, and a typing row with Enter/Backspace/Tab/Esc.
"New tab" opens a tab on the desktop host. The agent's cursor is drawn on the frame, and a tab an
agent is working in carries the agent cursor icon on its tab chip. The app needs a build containing this feature; it is
a pure JavaScript change, so an over-the-air update or Metro reload is enough.

## How It Works (and What It Never Touches)

- Frames come from the existing `preview.remoteSnapshot` path: the desktop captures its own
  rendered tab and returns a JPEG over the environment WebSocket, so Tailscale connections keep
  the desktop's cookies and signed-in state.
- Input goes through a `preview.remoteInput` RPC that forwards your gesture into the same
  per-tab, serialized automation operations agents use (`click`, `scroll`, `type`, `press`,
  `drag`, and `contextMenu`, which right-clicks and hands back what was under the pointer instead
  of opening the desktop's native menu). Your phone sends coordinates as fractions of the frame; the server converts them
  against the host's measured viewport at dispatch time, so window resizes can't skew a tap.
- The desktop always keeps rendering its own guest. Remote viewers are only viewers plus input
  senders — nothing about host selection, rendering, or navigation semantics changes when a
  remote device connects.
- Sound uses `preview.tabAudioWatch` (viewers) and `preview.tabAudioPublish` (the desktop). The
  server counts listeners per tab and tells the desktop's browser host which tabs have any; the
  desktop captures a tab (Chromium tab capture) only while it is both listened to and audible,
  encodes Opus with WebCodecs, and publishes 100 ms batches. Viewers decode with WebCodecs and
  play on a Web Audio clock that drops a backlog rather than falling behind.

## Saved passwords and PINs for agents

Manage logins, PINs, and codes in **Settings → Credentials**. Each entry has a type, a label, a
website, and its secret. A **Password** entry can also carry a username or email; a **PIN or code**
entry has none. Add, edit, and delete entries there; deleting asks for confirmation first. The
secret field is write-only: editing an entry starts it blank, and leaving it blank keeps the saved
secret, because the app never shows it again. Changing an entry's type keeps its secret, so a PIN
saved as a password before version 0.1.649 can be switched without retyping it. The preview's
**More > Save password or PIN…** menu opens the same editor with the tab's website already filled
in, and **Saved passwords and PINs** in the command palette opens the tab.

Solla Code normalizes the saved website to an exact origin and accepts HTTPS sites (plus localhost
for development); a bare host such as `github.com` is read as HTTPS. The operating system encrypts
the password before an atomic, owner-only vault file is written, and saving is refused when that
encryption is unavailable.

An agent first calls `preview_credentials`, which returns matching labels, usernames, types
(`password` or `code`), and opaque IDs for the active tab's exact origin. It types the username itself with `preview_type`, then calls
`preview_fill_credential` with an ID and the password field's target. Electron checks the live tab
origin again, decrypts in the main process, and sends the password directly into the selected page
document. The secret is absent from the tool arguments and result, server and WebSocket traffic,
activity receipts, and logs. Agents are told to try a saved entry before asking you to sign in or
enter a PIN, and never to ask for a password, PIN, or code in chat.

A saved password only goes into a password field (`<input type="password">`); any other target is
refused before anything is typed, so a password can't land in a plain text box where the agent would
read it back. A PIN or code may also go into a single-line text, tel, number, or search box, because
many sites ask for one there. Anything else, such as a textarea or a button, is refused. A PIN in a
plain text box shows on the page, so it can appear in the screenshot a snapshot takes. Page snapshots
never include a password field's value, and once a secret has been filled into a tab, that tab's
snapshots, `preview_evaluate` results, and status reads show it as `••••••••` wherever it appears,
including percent-encoded in a URL. For a short PIN that also masks matching digits elsewhere on the
page. Closing the tab forgets it.

Payment and PIN forms are often embedded in an iframe. Filling and `preview_type` reach fields inside
frames from the same site as the page: by the field's own selector, by Playwright's frame locator
form (`iframe#pay >> internal:control=enter-frame >> #pin`), or by coordinates. A frame from another
site can't be read or edited, so the agent is told it can't fill there and asks you to enter the
secret on the page.

Saved passwords and PINs live in the desktop app on the environment's own machine, because that is where
agents' browser tabs run. The Credentials tab is in every client: the desktop app, the web app in
another browser or on a phone, and the mobile app (**Settings → Credentials**, one list per
connected environment). A client that is not that desktop app sends its changes through the server
to it, so the desktop app must be open there; if it is closed or asleep, the tab says the passwords
could not be loaded and offers **Try again** rather than showing an empty list. A new password
crosses the connection once, on its way in, and the server does not store, log, or return it.
Remote clients get the same labels, usernames, and websites the desktop shows, and nothing more.
Only the desktop app signed in on that machine can answer these requests; another device cannot pose
as the vault.

## Limitations

- **It's frames, not video.** ~2.5s cadence is fine for tapping through flows and filling forms,
  not for scroll-reading. Each input snaps a fresh frame so you see its effect quickly.
- **The desktop app must be running** with the environment reachable; there is no host without it.
- Remote input is treated as automation on the desktop side, so it does not pause an agent
  driving the same tab the way physical input at the desktop does.
- DevTools and CAPTCHA/human-verification challenges stay under the desktop host's enforcement.

## Responsive dimensions and sign-in windows

Responsive width and height describe the page's CSS viewport. The page scales down to
fit the panel, and its resize handles stay aligned with its visible edges even when
Solla Code's application zoom is changed. Press Enter after editing a dimension, or
move focus outside the device toolbar, to apply it.

Google sign-in uses the site's popup flow in the desktop preview. The desktop engine
currently lacks the browser-mediated FedCM account dialog, so previews disable that
unsupported API and allow sign-in libraries to use their popup fallback. Account
selection and any verification still happen on the provider's own sign-in page.

## Inactive tabs

Browser tabs close automatically after **30 minutes without interaction**, checked once a
minute by the environment server. Opening or selecting a tab, typing, clicking, scrolling,
manual navigation, and agent browser work reset its inactivity window. Background page loads,
status checks, and the phone's automatic frame refreshes do not. Simply leaving a tab visible
does not keep it open forever. The timer also works while a remote client is disconnected.

Tabs needed for unresolved approvals, download approvals, human verification, or **Waiting on
you** cards stay open. A card with a page link protects tabs on that site. Chat-level approvals,
cards without a link, and links that no longer match an open tab (such as a sign-in redirect)
conservatively protect that chat's tabs. Connected side-chat approvals protect the parent chat's
shared browser. Resolving the request starts a fresh 30-minute inactivity window.

Closing a browser tab does not archive its chat. Use **+** in the browser tab strip to open the
page again. The same policy applies to desktop, the remote web client, and the native mobile app.
