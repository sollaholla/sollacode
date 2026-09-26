# Deep Code

Solla Code runs DeepSeek's [Deep Code CLI](https://github.com/lessweb/deepcode-cli) on the environment host. Add the provider instance in Settings, press **Install**, then add a DeepSeek API key. Remote environments need their own installation and `~/.deepcode/settings.json`.

Settings runs the install on the environment host, so the button is the whole step on a remote box too. To do it by hand instead:

```bash
npm install -g @vegamo/deepcode-cli
deepcode --version
```

Create `~/.deepcode/settings.json`:

```json
{
  "env": {
    "MODEL": "deepseek-flash",
    "BASE_URL": "https://api.deepseek.com",
    "API_KEY": "sk-..."
  },
  "thinkingEnabled": true,
  "reasoningEffort": "max"
}
```

Get an API key from the [DeepSeek Platform](https://platform.deepseek.com). The same file is shared with the Deep Code VS Code extension.

## Supported behavior

- Text prompts through `deepcode --exec` with a short `--prompt` instruction and the full request piped through standard input. This avoids Windows command-line limits, preserves Unicode and multiline requests, and also applies to resumed turns and context-recovery attempts. The CLI prints the final assistant reply when the turn finishes.
- Native session resume across turns using the session UUID Deep Code stores under `~/.deepcode/projects/<projectCode>/sessions-index.json`.
- Per-turn model (`DEEPCODE_MODEL`) and reasoning effort (`DEEPCODE_REASONING_EFFORT`: `low`, `high`, or `max`).
- Turn interruption and session shutdown. Solla owns the spawned child and forces termination after a two-second graceful shutdown window.
- Tool-call activity. `--exec` prints only the final reply, so after the turn exits the adapter reads the messages this turn appended to `~/.deepcode/projects/<projectCode>/<sessionId>.jsonl` and records each tool call and result as a normal thread activity. A resumed session is fenced to the messages appended after the previous turn, so earlier tool calls are not replayed.
- Stall watchdog. The CLI can wedge mid-request without exiting. When its session file sits unchanged for five minutes, Solla stops the turn and fails over to another provider instead of spinning forever; the Deep Code account rests thirty minutes before the thread may return to it.

The driver probes `deepcode --version` and reads `~/.deepcode/settings.json` (or `DEEPCODE_API_KEY`) for authentication. It never logs the API key. Executable presence is not authentication proof.

## Transport limits

Headless `--exec` cannot confirm permission prompts. Keep `permissions.defaultMode` as `allowAll`, or pre-allow the scopes the agent needs. An `ask` policy fails the turn with Deep Code's exec-mode error.

The current adapter takes one text prompt per turn. It does not stream image data inline: an attached image is handed to the agent as the on-disk path the server persisted it under, and the agent reads the file with its own tools. It also does not support live steering, plan-mode toggling, per-task stop, provider-native fork or rollback, interactive approval replies, live-streamed tool activity (tool calls are recorded when the turn ends, not while it runs), or auxiliary text generation. The driver advertises these limits through capabilities instead of claiming unsupported operations work.

A follow-up sent while a turn is running cannot join that turn because exec has no steering channel. Solla stops the running turn so the message is delivered as the next turn on the same resumed session, rather than waiting for the exec process to finish. Solla does not inject its thread-scoped MCP tools into Deep Code; existing CLI MCP configuration remains under the CLI's own control.

Official install notes: [DeepSeek Deep Code integration](https://api-docs.deepseek.com/quick_start/agent_integrations/deepcode/).

## Focused verification

Run the protocol, driver, and adapter test files under `apps/server/src/provider`. Ordinary tests use an owned fixture subprocess and do not call a model.

## Follow-ups and context recovery

Sending a follow-up ends the current exec invocation intentionally. Its work summary says “Continued with your follow-up,” and the next turn resumes with the message instead of labeling the handoff an unexpected interruption.

The adapter asks Deep Code to compact at 128K tokens unless the environment explicitly sets a different `DEEPCODE_AUTO_COMPACT_WINDOW`. It also checks the saved active transcript before resuming. When that context is too large, or the API explicitly rejects its context length, Solla continues once in a fresh native session with bounded excerpts, the current request, and a reference to the untouched original transcript. The agent can recover older decisions with narrow reads. Completed commands must not be repeated. An unrelated HTTP error is not retried through this recovery path, and a second context rejection remains a failure.
