# Muse Code

Meta's terminal coding agent, driven through its own session protocol rather than a headless one-shot command.

## Install and sign in

Install from **Settings → Providers → Muse Code**, or run the vendor script yourself:

```bash
curl -fsSL https://dev.meta.ai/install.sh | bash     # macOS and Linux
irm https://dev.meta.ai/install.ps1 | iex            # Windows PowerShell
```

Both scripts drop a launcher into a user-local bin directory (`~/.local/bin/muse` on POSIX), so neither needs elevation.

Installing does not sign you in. Run `muse login` in a terminal to connect your Meta account — the provider card shows that command with one-tap copy. Solla Code reports the provider as installed-but-unauthenticated until `~/.config/muse/auth.json` exists; there is no in-app sign-in, because nothing in the app can complete Muse's own browser flow.

Signing in is not enough on its own: **the account also needs a Muse plan.** Without one, `model/list` still returns Meta's whole catalogue, but every entry comes back `isActive: false` — the CLI's own picker calls this "model catalog has no visible models". Solla Code offers only active models, and says so on the provider card rather than showing an empty list with no reason. Add a plan at <https://developer.meta.com/ai/lp/muse-code/>. (Muse's CLI prints an Accounts Center deep link instead, but that one only resolves for a browser already signed in to Meta - signed out it bounces through an OIDC login that dead-ends in a 404.)

## How the integration works

Turns run against a long-lived `muse serve` host speaking **MSP**, a JSON-RPC 2.0 session protocol over stdio. Each thread owns a scoped host, and its session outlives individual turns. That supports:

- **Live thoughts and tool calls.** Reasoning and tool activity arrive as `item/*` notifications while the turn runs, instead of being reconstructed from a transcript after the process exits.
- **Native steering.** A mid-turn message joins the running turn through `turn/steer`, carrying the turn id it expects so input can never leak into the next turn. Nothing has to be interrupted and redelivered.
- **Images on the wire.** Attachments are sent as image input parts rather than as on-disk paths the agent has to go and read.
- **A live model catalog.** Models come from the host's `model/list`, so the picker shows what the signed-in account actually serves. Signed out, the catalog is empty and no model is offered — Solla Code does not substitute guessed ids.

Reasoning effort maps onto Muse's tiers (`none` … `ultra`). Solla's **max** selects Muse's `max` rather than `ultra`, so "max" means the same thing here as it does for every other provider.

Muse fixes its sandbox posture when the host starts. **Full access** therefore starts that
thread's host with the sandbox disabled and applies its approval mode separately. Restricted
threads retain their own sandboxed hosts. Changing access mode closes the old host before
resuming with the new grant, and the session must acknowledge the requested approval mode.
An unexpected host exit makes the session inactive and recoverable instead of retaining a
cached ready state. Restarting uses the saved session cursor.

## Capabilities

| Capability            | Supported | Note                                                                  |
| --------------------- | --------- | --------------------------------------------------------------------- |
| Live steering         | Yes       | `turn/steer` with an expected turn id                                 |
| Streaming reasoning   | Yes       | Drawn as thoughts between the tool calls they narrate                 |
| Image attachments     | Yes       | Sent as wire input parts                                              |
| Model switch in place | Yes       | `session/setModel`                                                    |
| Interrupt             | Yes       | Reported as an outcome, never as a failed turn                        |
| Host MCP tools        | Yes       | Native session MCP when granted; authenticated shell client otherwise |
| Account usage         | No        | Muse does not report account usage to its CLI                         |
| Thread fork/rollback  | No        | Not exposed to this adapter                                           |

## Host tools and persisted history

Solla prepares a credential scoped to the current thread before starting or resuming Muse. The adapter requests `sessionMcp` and passes the authenticated `t3-code` server in session configuration only when the host grants that capability.

Muse 1.2.1 advertises session MCP configuration in its exported schema but does not grant `sessionMcp` in the tested host. That host also accepted a required server with an unreachable endpoint without connecting to it. Sending configuration alone therefore does not prove tool access.

When native tools are absent, the common provider service supplies a private, session-scoped MCP client that Muse can call through its shell tool. It supports tool discovery, schema inspection, and authenticated calls such as `thread_history_query`. Credentials remain in a host file with owner-only permissions, and the file is removed when the credential is revoked. The same fallback is supplied to other providers, including new adapters. Native tools remain preferred when available. Standalone provider slash commands are preserved.

The real-model test below verifies that Muse actually calls the authenticated history tool. A CLI schema or successful session start alone is insufficient evidence.

## Wire notes

The protocol is self-describing: `muse schema generate-ts --out DIR` writes types that are precomputed at build time and exact for that binary. This build was written against Muse Code 1.1.1, schema version 1, fingerprint `sha256:c669a30c…3e6a4f`. If a future CLI reports a different fingerprint the adapter logs a warning and keeps running — re-export and diff the schema if events start looking wrong.

Four rules the binary enforces that its schema does not state, all found by running it:

1. `clientInfo.name` must match `^[a-z0-9_]+$`. The product's own name is rejected for its hyphen, so the client identifies itself as `solla_code`.
2. The handshake is two-step. After the `initialize` response the client must send an `initialized` notification, or every later call fails `notInitialized`.
3. Every `commandId` must be a UUID**v7**, not merely a UUID. The platform's `randomUUID()` is v4 and is rejected.
4. `--no-session-log` serves no view plane at all: turns are accepted but no `turn/started`, no `item/*`, and no `turn/completed` ever arrives, and `view/subscribe` answers `methodNotFound`. The host is therefore always run with its session log enabled. Sessions land under `~/.local/share/muse/sessions/`.

Two more, found once an account was signed in: the credential file is `auth.json`, **not** `.auth.json` — that dotted name belongs to the lock file beside it, which exists from the CLI's first run and so reports every account as signed out forever. And catalog entries use `displayLabel` and `contextLimit`, not `displayName`/`contextWindow`; reading the wrong ones yields models labelled with their own slug and no context size.

One transport rule matters as much: the host's stdin is a sink consumed exactly once, so a single long-lived stream drains a queue of outbound frames. Opening a fresh write per frame passes a one-request smoke test and then blocks forever on the second frame, which stalls the handshake and every turn after it.

## Restoring saved replies

At server startup, a bounded sweep repairs recent Muse threads whose latest completed turn has no assistant message. A stopped thread whose latest turn was interrupted is also eligible, so earlier replies lost before Stop can be restored while the thread stays stopped. Active work, pending input, archived threads, and changed provider ownership are excluded.

The repair reads the existing saved session through the catalog host's `view/page` endpoint. It reads at most 20 backward pages of 200 events, starting at the latest stored event, then delivers completed assistant snapshots chronologically through normal ingestion. It requires native session, turn and item identifiers, preserves available native timestamps, and uses stable event IDs for deduplication. It does not resume a session, send a model prompt, or change runtime bindings. Historical completion provenance prevents restored progress or final messages from creating automatic continuation work, including when a ready-state refresh arrives between replayed messages.

## Testing

The adapter's tests run against a stand-in host that enforces the same four rules. An opt-in end-to-end test drives the real CLI:

```bash
T3_LIVE_MUSE=1 vp test apps/server/src/provider/Layers/MuseLive.test.ts
```

The test selects an `echo` provider configuration, but provider naming alone is not evidence of a free or model-free turn; treat real CLI turn probes as potentially quota-consuming. It skips when the CLI is absent.

To verify host MCP access with the real Meta model (uses account quota):

```bash
T3_LIVE_MUSE=1 T3_LIVE_MUSE_MODEL=1 vp test run apps/server/src/provider/Layers/MuseLive.test.ts -t 'calls authenticated'
```

The probe uses an isolated local MCP server and verifies the exact `thread_history_query` call and its thread credential; it does not read existing conversations or modify the workspace.

### Saved-session progress recovery

When an old live-view cursor has expired, Solla continues reading the session’s durable progress pages instead of repeatedly trying the rejected anchor. This fallback does not add a warning to the work log. Authorization errors and failures to recover the final reply remain visible.
