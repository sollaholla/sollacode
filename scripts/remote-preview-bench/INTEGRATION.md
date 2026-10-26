# Real preview component verification

`integration.ts` hosts the synthetic page in its own Electron process and registers that host with
an **existing isolated development server**. It does not start a server against Solla data, create a
thread or tab, change the app router, or replace any viewer hook. Open the ordinary Preview panel
in the paired development web app to exercise its actual `PreviewView` and `RemoteBrowserFrame`.

Prerequisites:

- A running isolated loopback dev backend, with the production changes built from this checkout.
- A disposable existing thread and a tab created through its real `preview.open` RPC/UI. The
  returned tab id must be supplied to the driver. An initial harmless URL is sufficient; the
  fixture reports its actual loopback URL and successful navigation through `preview.reportStatus`.
- A bearer session issued by that dev server with normal preview operation permissions. Put only
  its raw token in a private temporary file. Do not use the packaged app's live credentials.
- The web viewer paired normally to the same dev environment. It can have a different session.

An optional bootstrap helper handles the fixture's pairing and tab creation. Mint a separate
agent-owned pairing URL with the auth CLI described in `test-t3-app`; never reuse the user's
viewer pairing URL. Save that complete URL in a private temporary file, then run:

```sh
node scripts/remote-preview-bench/integration-bootstrap.ts \
  --base-url http://127.0.0.1:DEV_BACKEND_PORT \
  --thread-id ffc63437-da0d-477a-8b30-f947313cc8c6 \
  --pairing-url-file /tmp/PRIVATE_AGENT_PAIRING_URL_FILE
```

The helper discovers `/.well-known/t3/environment`, exchanges only that supplied token through
`POST /oauth/token`, and calls the real `preview.open` RPC without navigating any external page.
It prints environment/thread/tab IDs and the path to a new mode-0600 bearer file in a private
temporary directory. Use those values in the driver command below. It starts no browser or server.
`BENCH_AGENT_PAIRING_URL` may replace the input file, so the pairing URL never needs to appear in
command-line arguments. Discovery failure does not consume the token; if tab creation fails after
pairing, the error reports the retained bearer-file path for recovery. Remove these agent-owned
temporary secret files when the integration environment is retired.

Example, substituting the actual dev port, environment id and tab id:

```sh
node scripts/remote-preview-bench/integration.ts \
  --base-url http://127.0.0.1:DEV_BACKEND_PORT \
  --environment-id DEV_ENVIRONMENT_ID \
  --thread-id ffc63437-da0d-477a-8b30-f947313cc8c6 \
  --tab-id CREATED_TAB_ID \
  --bearer-file /tmp/PRIVATE_DEV_SESSION_TOKEN_FILE \
  --out /tmp/solla-preview-integration
```

The driver prints and saves `integration-ready.json` with its scene, status and control URLs, never
the bearer token. It serves its page and controls only on an allocated loopback port, rejects the
packaged app's port 3773, and stops after 30 minutes. `--build-only` validates the renderer without
launching Electron or a server. `BENCH_SESSION_BEARER` may replace `--bearer-file` when already set
in a private process environment.

The fixture includes an editable Message field, a click counter and enough text to scroll.
`GET STATUS_URL` reports the source's actual field value, click count and scroll position along
with capture/codec counters. This lets the integrated viewer prove that normalized input reached
the original source rather than merely changing its own UI.

Use `POST CONTROL_URL`, content type `application/json`, for these bounded actions:

| Body                                                 | Purpose                                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{"action":"scene","name":"fixture"}`                | Restore the interactive fixture. Other scene names are idle, ticks, caret, spinner, typing, scroll, video and input.                                                |
| `{"action":"title","title":"Updated preview title"}` | Change the native title and publish real page metadata.                                                                                                             |
| `{"action":"pointer","x":0.3,"y":0.4}`               | Publish an agent pointer in page fractions.                                                                                                                         |
| `{"action":"video","enabled":false}`                 | Re-register as a host without video capability, preserving the JPEG path for fallback verification.                                                                 |
| `{"action":"video","enabled":true}`                  | Re-register with video capability.                                                                                                                                  |
| `{"action":"restart"}`                               | Stop and relaunch only this driver's owned Electron process, then reconnect the fixture.                                                                            |
| `{"action":"resize","width":900,"height":600}`       | Resize the actual native source, await its measured CSS viewport, then restart capture through the production helper. Each dimension is bounded to 240–1600.        |
| `{"action":"capture","available":false}`             | Release the current native track and make subsequent fixture source opens fail; exercises the real publisher's failure path and JPEG fallback.                      |
| `{"action":"capture","available":true}`              | Permit native source opens again. The existing publisher retries within its bounded backoff (at most 10 seconds), so video can recover without reopening the panel. |
| `{"action":"stop"}`                                  | Close its host, controls and scene server.                                                                                                                          |

Suggested integrated checks: first-frame JPEG-to-video handoff; type and click verification through
source status; scroll and zoom input geometry; title and cursor changes; hide/reopen the Preview
panel and inspect capture release/reacquisition; host restart; video-disabled JPEG fallback and
video re-enable. Keep browser-engine evidence distinct from a physical iPhone test. Close the
fixture tab through the normal app after stopping the driver.
