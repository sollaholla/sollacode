# Harness and user experience audit, November 1

Scope: the agent-running layer (provider adapters, orchestration, MCP tools, the updater, the release pipeline) and the web client on desktop and phone-sized Safari. Evidence came from a read-only copy of real data, server and desktop traces, the full test gate, and a pass through the running app with provider CLIs and credentials removed.

## Fixed

| Finding                                             | Evidence                                                                                                                          | Change                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| No release could pass preflight                     | Check, typecheck and tests red on `main`; nightly failing every three hours; last stable five weeks old                           | Repaired two `jsdom` tests that lacked the package, one stale asset URL test, and type and lint errors in two scripts   |
| History lookups froze the whole server              | `sql.execute` spans of 5.6 to 6 s. The query sorted a thread's full union before its limit, and SQLite calls block the event loop | Each source sorts and limits on its own index before merging: 4.5 s to 1 ms for the same page on a 384k-activity thread |
| Shell-client instructions repeated on every message | About 190 tokens per user message, kept in provider context                                                                       | Adapters declaring `nativeHostTools` (Claude, Codex) receive them once per session. Others keep them on every turn      |
| Composer hint hidden on phones                      | Simulator screenshot: "or /" sat under the emoji button                                                                           | Hint keeps clear of the button in both the Lexical editor and the iOS textarea                                          |
| Hard-to-read text                                   | Measured contrast: composer hint 2:1, settled sidebar rows 2.5:1                                                                  | Raised to readable levels                                                                                               |
| No first-launch guidance for unsigned builds        | CI macOS builds are ad-hoc signed and not notarized; no documentation mentioned the system warning                                | Install guide in the quick start, the download page and release notes                                                   |

## Checked and healthy

- Interactive elements on the routes sampled (chat, Settings pages, Live Inspector) have accessible names, no nested controls, and no horizontal overflow at desktop width.
- RPC requests answer within about 70 ms at p95.
- Turn errors are low. Most `incomplete` turns line up with app restarts during updates.
- A thread with 17,760 messages opens without a visible stall.
- No secrets in the commits published with this release.

## Open

- **Provider-update toast on phones** covers the Settings tab strip until dismissed.
- **Missing attachments** are re-requested every 30 minutes by the URL refresh. Harmless, but the failed lookups repeat.
- **Diagnostics labels** measure about 2.8:1 contrast.
- **Native mobile app** was not exercised. The phone pass covered the web client in iOS Safari. `apps/mobile/app.config.ts` still names the upstream Expo owner, which needs a fork-owned account to change.
- **Windows updater port discovery** parses and its fallback runs, but the discovery path has not run on Windows.
- **Cursor, Grok and OpenCode** keep per-turn host-tool instructions until recorded tool calls confirm their native transport.
- **Signed builds** need the Apple and Azure secrets described in [the release checklist](./release.md).
- **Upstream performance audit** items from October 29 onward remain unimplemented.
- **Lint warnings:** about 60 remain. They do not fail the gate.
