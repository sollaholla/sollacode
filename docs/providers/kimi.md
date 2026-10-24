# Kimi Code

Solla Code runs Moonshot AI's Kimi Code CLI (`kimi`) on the environment host over the Agent Client Protocol (`kimi acp`). Install it with the CLI's own installer — **Install** in Settings runs `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash` (PowerShell `irm https://code.kimi.com/kimi-code/install.ps1 | iex` on Windows) — then sign in with `kimi login` in a terminal. Remote environments need their own installation and sign-in.

## Models and sign-in

The model list is the CLI's own: Solla reads `kimi provider list --json` for the models and `kimi provider list` for the default, and puts that default first. A model Kimi does not advertise in the session is never sent; the session keeps Kimi's current model and reports it. Nothing is hardcoded, so a model Moonshot adds appears after the next provider refresh.

The provider status check runs `kimi acp` only as far as `initialize` and `authenticate`. Kimi's `authenticate` checks the stored token and never starts a login, and no session is created, so checks do not add entries to the person's Kimi history. A signed-out CLI shows **Kimi Code is not signed in**, and the sign-in command is `kimi login`.

## Supported behavior

- Streamed assistant text, thinking, tool activity, and plan (todo) updates.
- Image attachments.
- Session resume through `session/load`; a resume that fails starts a fresh session.
- Plan interaction mode (Kimi's `plan` mode). When Kimi presents its plan, Solla shows it as a plan card and ends Kimi's turn; you settle the plan from the card as with other providers.
- Questions Kimi asks (its AskUserQuestion tool) always come to you, in every access mode. Kimi accepts only one of its listed answers, so free text dismisses the question.
- Access modes: Full access and Auto run Kimi in `yolo` (tools auto-approved, questions still asked); Approval required and Auto-accept edits run Kimi's `default` mode, with Kimi's `Write` and `Edit` approved automatically in the latter.

## Limits

- **No live steering.** Kimi refuses a prompt while one of its turns is running. A message sent mid-turn interrupts the turn and is delivered as the next one in the same session.
- **No reasoning-effort picker.** Kimi 0.28 does not expose effort over ACP; it follows `[thinking]` in Kimi's own `config.toml`. A thinking on/off toggle appears only for models that can switch thinking off.
- **Solla's tools come through the host shell client.** Solla does not register its MCP server with Kimi natively yet: Kimi passes tool schemas to its API unchanged, and some of Solla's schemas have the multi-description `allOf` shape that Moonshot's validator rejected for OpenCode. Native registration needs one signed-in test turn first.
- **No context meter.** Kimi does not report token usage over ACP. Plan quota does appear in the usage pill; see [Kimi Code plan usage](../user/provider-usage.md#kimi-code-plan-usage).
- **No auxiliary text generation** (titles, commit messages) and no fork, rollback, or per-task stop.
- **Failed turns.** Kimi reports a failed turn (an API or plan error after its own retries) as an ordinary end with no output and writes the reason only to its own log. Solla marks a turn that produced nothing as failed and points to `~/.kimi-code/sessions/<workspace>/<session>/logs/kimi-code.log`.

## Focused verification

`KimiAcpSupport.test.ts`, `KimiProvider.test.ts`, and `KimiAdapter.test.ts` under `apps/server/src/provider`. The adapter test drives a stand-in agent whose `initialize` and `session/new` payloads are the ones Kimi Code 0.28.1 returned to a raw probe, and whose permission requests use Kimi's own option ids. No test sends a prompt to Kimi or spends quota.
