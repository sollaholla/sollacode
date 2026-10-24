# Remote Access

Solla Code clients should use the web client served by their Solla environment. A separately hosted client requires an operator-configured `VITE_HOSTED_APP_URL`; this fork has no default hosted service. Build this checkout before running the source-server commands below. See [Fork identity](../reference/fork-identity.md).

Use this when you want to connect to a Solla Code server from another device such as a phone, tablet, or separate desktop app.

On a phone, open the navigation sidebar and choose **Settings** at the bottom.
The mobile web header contains the navigation button and Solla Code home link.

## Recommended Setup

For devices on the same trusted Wi-Fi or Ethernet network, use the built-in LAN connection flow.
Tailscale is not required.

1. Open **Settings** → **Connections**.
2. Under **Connect another device**, choose **Show QR code**.
3. Scan the large QR code with the other device, or copy and open the connection link.
4. Solla Code opens, exchanges the one-time credential, and saves the environment automatically.
   There is no code to type.

For another computer already running Solla Code on the same private network, use **Nearby Solla
Code** instead. Choose **Trust and add**, then approve the native trust prompt on the other
computer. Both environments are added in parallel and can reconnect automatically.

Nearby connections include access to the other computer's agents. Credential renewal
preserves the permissions saved on the host. If an older renewal dropped agent access
from a previously trusted Nearby connection, updating the host restores that grant
automatically when the devices reconnect. Custom restricted connections and revoked
credentials retain their restrictions.

Use Tailscale or another trusted HTTPS/private-network endpoint when the devices are not on the
same LAN or when you need a stable address across networks.

## Push notifications

For alerts while the page is closed, enable [push notifications](push-notifications.md) from
**Settings → Agents**. Use the HTTPS Tailscale address; on iPhone/iPad, first add Solla Code to the
Home Screen and open it from that icon. No App Store app is required.

## Double-tap

Double-tapping no longer zooms the page anywhere on a phone, including inside the chat, the sidebar
and other scrolling lists. Pinching and panning are unchanged, and the image viewer keeps its own
pinch and double-tap zoom.

The size of the interface on a phone follows Safari's own **aA** text size for the site. The app does
not scale itself; set the percentage there to taste (75% suits the phone layout).

## Bandwidth

Solla Code keeps a phone's data use low without changing what you see.

- **Compression.** The live connection and the web app's files are compressed.
- **Provider status.** A change that only moves a usage reading or a "last checked" time is sent as a
  few hundred bytes instead of every provider's full model, command, and skill catalogue (about 15 KB).
  Anything else about a provider is still sent in full. Older apps that do not ask for this keep
  receiving the full list.
- **Long tool results.** When a thread opens or catches up, an MCP tool result longer than 8,000
  characters is cut there, with "… N more characters not shown" at the cut, and the duplicate
  `structuredContent` copy of a result is not sent. This roughly halves what a busy thread sends.
  The expanded row and Copy show the shortened text; the full result stays in the saved history.
  Images and the tool's arguments are never cut.
- **Remote browser.** While a browser tab is open on your phone, a page that has not changed since
  the last picture is answered with its address, title, agent cursor, and pending approvals, without
  the picture again. Only a changed page downloads a new frame.

## Long thread names

The thread name in the header stays on one line and is cut off with an ellipsis when it does not fit.
When the row is tight, a long project name shortens first so the thread name always keeps room to be
tapped. Tap the thread name to see its full name in a popover under the header (a mouse can also hover
it). A name that already fits does nothing when tapped. The header has a fixed height, so the name never expands in
place.

## Host battery and storage

A thread, draft, or agent that runs on another machine shows that machine's free disk space, and its
battery when it has one. On a phone it sits at the very top right of the top bar, on the same row as
the Solla Code icon and title; inside an agent it stays to the left of the agent's avatar, including
when the agent card is collapsed into that bar. On a wider layout it ends the thread header row. A
laptop shows both (for example `87%` and `66 GB`); a desktop or server shows only storage. The
battery icon changes while the machine is charging. Home and Settings show no chip.
Values turn amber below 20 GB free or 20% battery, and red below 5 GB free or 10% battery. A
charging machine never turns red or amber for battery. The chip retains its last reading while
disconnected; the Wi-Fi icon shows the connection state. The desktop app hides the chip for its own
environment. The reading is taken from the disk holding the environment's state directory and
refreshes every 30 seconds only while the chip is on screen.

## Remote Control

Only remote-hosted threads show **Remote control** beside the project action controls. Selecting it
connects directly to that thread's saved host when necessary, then opens that computer's live
remote-control window. Local threads do not show the control.

Remote control always starts with approval on the host computer. The host can decline, grant
view-only access, or allow screen, pointer, and keyboard control. Primary shortcuts translate
between Command on macOS and Control on Windows. The host can stop the session at any time.
Pointer motion is sampled to the current display frame and stale unsent motion is replaced rather
than replayed. Keyboard holds use down/up state edges instead of buffering browser repeat events.

A small blue pulsing dot appears immediately where you tap, matching the agent cursor. It remains until the host confirms that
the mouse press was applied, then disappears. A red dot means the press failed or was blocked;
it clears on your next gesture. Turning a touch into a scroll or pinch cancels its initial dot.
Reduced-motion settings show a steady dot instead. This feedback also appears in the remote
browser preview, where it waits for the browser action to complete.

Selecting **Remember for this device** remembers only the capabilities approved for that paired
device. A later request for additional capabilities still requires approval, and removing then
pairing the device again clears the remembered approval.

For a remembered device the computer approves instantly and shows no prompt, because there is
nothing left to approve. The requesting device should then go straight to the screen. If it ever
sits on "Approve on <computer>" while the computer shows nothing to approve, update both Solla Code
installs: before 0.1.686 the requesting device could miss the approval, because the host sent it in
the same batch as the first video data and only the last item of a batch was read.

On macOS, screen streaming requires Screen Recording permission and interactive control requires
Accessibility permission under **System Settings** → **Privacy & Security**.

On Windows, Solla Code must run in the signed-in desktop session and at the same or a higher
privilege level than the application being controlled. If Windows rejects pointer or keyboard
injection, the controller receives the host error instead of a false success.

## Enabling Network Access

There are two ways to expose your server for remote connections: from the desktop app or from the CLI.

### Option 1: Desktop App

If you are already running the desktop app and want to make it reachable from other devices:

1. Open **Settings** → **Connections**.
2. Choose **Show QR code** under **Connect another device**.
3. Scan the QR code or open the link on the other device.

New desktop installs enable private-network access by default. If the QR panel asks you to enable
it, open **Advanced connection settings**, turn on **Network access**, and let Solla Code restart.

Advanced connection settings show the default reachable endpoint, with a `+N` control when more
endpoints are available. The default controls the QR code and connection link. The preference is
stored by endpoint type, so choosing the local LAN endpoint survives normal IP address changes when
you move between networks.

A verified Tailscale HTTPS endpoint takes precedence for new QR codes and pairing links.
Without one, the app uses the saved endpoint preference or an available default endpoint,
usually LAN. This affects new pairing links, not addresses already saved by another client.

- HTTPS/WSS-compatible endpoints can be used from an HTTPS-hosted client.
- Non-loopback HTTP endpoints are useful for direct LAN pairing.
- Loopback-only endpoints are not useful for another device unless that device is the same machine.

The copied link points directly at the selected environment. Open a LAN link from a client that can reach that LAN address, or select its HTTPS Tailscale endpoint for another device on the tailnet. Pairing credentials stay in the URL fragment.

### LAN Troubleshooting

Nearby discovery advertises separately on every private IPv4 subnet so Windows virtual adapters,
hotspots, WSL, Hyper-V, VPNs, and Docker networks do not hide the active Wi-Fi or Ethernet adapter.
Solla Code retries discovery automatically if the network or permission is temporarily unavailable.

If another device does not appear:

- confirm both devices are on the same private Wi-Fi or Ethernet network
- keep Solla Code open on both devices
- on Windows, allow **Solla Code** through Windows Defender Firewall for the current network profile
- on macOS, allow Local Network access if macOS asks
- check that guest Wi-Fi or access-point isolation is not blocking devices from reaching each other

The Connections screen reports permission, unavailable-network, and UDP port conflicts directly and
continues retrying after the problem is corrected. Installing Tailscale is not a LAN troubleshooting
step.

### Tailscale Endpoints

When the desktop app can detect Tailscale, it adds Tailnet endpoints to the reachable endpoint list.

Depending on your Tailscale setup, this may include:

- the machine's `100.x.y.z` Tailnet IP
- a MagicDNS name
- an HTTPS MagicDNS endpoint when Tailscale Serve is configured for this backend

The Tailscale HTTPS endpoint uses the clean MagicDNS URL, such as
`https://machine.tailnet.ts.net/`, and is disabled until the app verifies that the URL reaches this
backend. Use **Setup** on the Tailscale HTTPS row to opt in. The desktop app restarts the backend
with the same server-side behavior as `t3 serve --tailscale-serve`, then the server asks Tailscale
Serve to proxy HTTPS traffic to the local backend.

The switch records the requested setting, while the status beneath it reports whether Serve is
actually effective. First-time Serve setup can require tailnet approval for HTTPS certificates. In
that case, use **Open Tailscale approval**, approve HTTPS in Tailscale, and return to the desktop
app; it checks again automatically when the app regains focus. **Check again** also retries the
prerequisite check, Serve configuration, and endpoint verification.

Tailscale HTTPS remains private to devices signed into the same tailnet. Solla Code invokes
Tailscale Serve only; it does not enable Tailscale Funnel or publish the backend to the public
internet. Local-network exposure is a separate setting.

The Tailscale support is an endpoint provider add-on. The core remote model still works without Tailscale: LAN HTTP endpoints, custom HTTPS endpoints, future tunnels, and SSH-launched environments all use the same saved environment and pairing flow.

For a separately hosted HTTPS client, use an HTTPS Tailnet or other HTTPS endpoint. A plain `http://100.x.y.z:3773` endpoint can still work from a desktop client or another browser page served over HTTP, but it will not work from the hosted HTTPS app because of browser mixed-content rules.

### Option 2: Headless Server (CLI)

Use this when you want to run the server without a GUI, for example on a remote machine over SSH.

Run the server with `t3 serve`.

```bash
node apps/server/dist/bin.mjs serve --host "$(tailscale ip -4)"
```

`t3 serve` starts the server without opening a browser and prints:

- a connection string
- a pairing token
- a pairing URL
- a QR code for the pairing URL

From there, connect from another device in either of these ways:

- scan the QR code on your phone
- in the desktop app, enter the full pairing URL
- in the desktop app, enter the host and token separately
- in the hosted web app, open a hosted pairing URL when the backend is reachable over HTTPS

Use `t3 serve --help` for the full flag reference. It supports the same general startup options as the normal server command, including an optional `cwd` argument.

For hosted web pairing over Tailscale HTTPS, opt in to Tailscale Serve:

```bash
node apps/server/dist/bin.mjs serve --tailscale-serve
```

By default this configures Tailscale Serve on HTTPS port 443 and advertises
`https://machine.tailnet.ts.net/`. Advanced users can choose a different HTTPS port:

```bash
node apps/server/dist/bin.mjs serve --tailscale-serve --tailscale-serve-port 8443
```

> Note
> The GUIs do not currently support adding projects on remote environments.
> For now, use `t3 project ...` on the server machine instead.
> Full GUI support for remote project management is coming soon.

### Option 3: Desktop-Managed SSH Launch

Use this when you want the desktop app to start or reuse Solla Code on another machine over SSH.

1. Open **Settings** → **Connections**.
2. Under **Remote Environments**, choose **Add environment**.
3. Select the SSH launch flow.
4. Enter the SSH target, such as `user@example.com`.
5. Confirm the launch. The desktop app probes the host, starts or reuses a remote server, opens a local port forward, and saves the environment.

After setup, the renderer connects to a local forwarded HTTP/WebSocket endpoint. The remote host still owns the actual T3 server, projects, files, git state, terminals, and provider sessions.

SSH launch is a desktop feature because it needs local process and SSH access. Once the environment is paired and saved, it uses the same environment list and connection model as direct LAN, Tailscale, HTTPS, or future tunnel-backed environments.

#### SSH Launch Troubleshooting

The desktop SSH launcher connects with a non-interactive `sh` session, writes a small launcher script under `~/.t3/ssh-launch/<host-key>/`, starts or reuses a remote server, and forwards the remote loopback port back to your desktop.

The remote host must have a compatible Node.js runtime. Solla Code uses the server package's `engines.node` requirement:

```text
^22.16 || ^23.11 || >=24.10
```

During SSH launch, Solla Code first checks whether `node` is already available on `PATH`. If it is missing, the launcher tries common non-interactive shell locations and version-manager shims/activation hooks:

- `~/.local/bin`, `~/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
- Volta via `~/.volta/bin`
- asdf via `~/.asdf/shims`, `~/.asdf/bin`, or `~/.asdf/asdf.sh`
- mise via `~/.local/share/mise/shims`, `~/.mise/shims`, or `mise activate sh`
- fnm via `fnm env --use-on-cd --shell sh` or `fnm env --shell sh`
- nodenv via `~/.nodenv/bin`, `~/.nodenv/shims`, or `nodenv init -`
- nvm via `$NVM_DIR/nvm.sh`, then `nvm use default`, `nvm use node`, or `nvm use --lts`
- installed nvm versions under `$NVM_DIR/versions/node/*/bin`

If launch fails with `node: command not found`, a port-scan failure, or a message that the remote Node version does not satisfy the required range, SSH into the host and check the same non-interactive shell path Solla Code uses:

```bash
ssh user@example.com 'sh -lc "command -v node && node --version"'
```

If that does not print a compatible Node version, configure your version manager for non-interactive shells or install a compatible Node binary in one of the searched locations. For example, with nvm you may need a default alias:

```bash
nvm alias default 24
```

With mise/asdf/fnm/nodenv, make sure the tool's shim directory is installed and points at a Node version satisfying the range above.

If reconnecting after an app update fails, retry the SSH launch once. The launcher now compares its generated runner script, stops stale launcher-managed remote servers, clears the SSH launch PID/port state, and starts a fresh remote server. You should not normally need to delete `~/.t3/ssh-launch` or kill `t3` processes manually.

## Updating a Remote Server

When the Solla Code web or desktop app and a remote server use different versions, a warning appears in
the conversation and in **Settings** → **Connections**. Follow the action shown there: Solla Code may
be able to update and reconnect the server for you, or it may ask you to update the desktop app or
run a copied command on the server machine.

Finish active work before updating because the server restarts briefly. For step-by-step guidance,
see [Keeping Solla Code in Sync](./server-updates.md).

On a Linux host, you can keep the server running after logout and manage it independently of the
connection method. See [Running Solla Code in the Background](./background-service.md).

## How Pairing Works

The remote device does not need a long-lived secret up front.

Instead:

1. `t3 serve` issues a one-time owner pairing token.
2. The remote device exchanges that token with the server.
3. The server creates an authenticated session for that device.

After pairing, future access is session-based. You do not need to keep reusing the original token unless you are pairing a new device.

## Hosted Web App Pairing

An operator can deploy a separate Solla web client with `VITE_HOSTED_APP_URL` set to its own origin. That client can save a remote backend from a URL like:

```text
https://client.example.com/pair?host=https://backend.example.com:3773#token=PAIRCODE
```

Use hosted pairing when the backend is reachable from the browser over HTTPS/WSS. This includes a backend behind a trusted HTTPS tunnel or another HTTPS endpoint you operate.

Do not use hosted pairing for plain HTTP LAN URLs such as `http://192.168.x.y:3773`. Browsers block an HTTPS page from connecting to an insecure HTTP or WS backend. For those endpoints, use the direct pairing URL shown by the desktop app or CLI from a client that can open that HTTP URL directly.

Hosted pairing does not proxy traffic through Solla Code. The browser still connects directly to the backend URL in the pairing link.

## Managing Access Later

Use `t3 auth` to manage access after the initial pairing flow.

Typical uses:

- issue additional pairing credentials
- inspect active sessions
- revoke old pairing links or sessions

Use `t3 auth --help` and the nested subcommand help pages for the full reference.

## Security Notes

- Treat pairing URLs and pairing tokens like passwords.
- Prefer binding `--host` to a trusted private address, such as a Tailnet IP, instead of exposing the server broadly.
- Anyone with a valid pairing credential can create a session until that credential expires or is revoked.
- Hosted pairing links keep the credential in the URL hash so it is not sent to the hosted app server, but it can still be exposed through browser history, screenshots, logs, or copy/paste.
- Use `t3 auth` to revoke credentials or sessions you no longer trust.

## Repairing a saved connection

A saved connection uses the address it was paired with. Installing or enabling Tailscale does not replace a saved LAN address automatically. Check **Settings → Connections** and reveal the saved address before changing firewall settings.

For a Tailscale connection, use the remote computer's verified HTTPS address, such as `https://computer.example.ts.net/`, or its Tailscale IP with the Solla server port. Both devices must be connected to the same tailnet with access permitted between them. A working SSH connection alone does not prove the Solla HTTP/WebSocket port is reachable.

In web and desktop, **Edit address** preserves the environment and existing pairing while replacing its HTTP/WebSocket address. Mobile's environment editor uses the same shared connection operation. The server's environment identity is checked before the saved credential is used. Older installed clients without the editor need to pair again using the correct address.

Disconnected version information is cached: “last seen” is not proof of the version currently running remotely. Check the remote server's current descriptor or reconnect before diagnosing version drift.

## Connection interruptions

While reconnecting, threads and agents retain their last observed content, appearance, and work
status. A working thread keeps its local elapsed-time counter running from the same start time.
The Wi-Fi indicator carries connection details and reconnect controls. These retained states update
when the host reconnects; the counter measures elapsed time, not newly confirmed progress. A thread
that has never been loaded still needs a connection before its conversation can be displayed.

Settings and provider changes appear as one separator at the original settings message. When the
host confirms the change, that separator gains a checkmark instead of adding a second separator.
Automatic provider transitions without a settings message still have their own entry.
