# OpenCode

Solla Code uses the OpenCode SDK and server for streaming text, tools, approvals,
questions, native compaction, and resumed conversations. Select a coding model
from the connected OpenCode catalog in the composer. Credentials and runtime
configuration belong to the environment host, including for remote clients.

## Tracking

Message and part events are scoped by their native session IDs. Text received
before assistant metadata is retained until the message role is known. Reasoning
stays separate from the answer, and tool output cannot become assistant prose.
Repeated terminal tool events do not create duplicate results or reopen tools.
An interrupted turn remains interrupted when OpenCode reports idle before its
abort error or before the abort request returns.

Completed assistant messages publish the latest token usage to Solla's existing
usage display. Cache reads, cache writes, and reasoning are counted once. Replayed
and older usage snapshots are ignored. The adapter uses the provider's total when
available; it does not invent an unknown context limit or a lifetime token total.

The usage bar shows **Session cost**, OpenCode's cumulative model-price estimate
from its native session snapshot. It is read on session creation/resume and updated
from `session.updated`, with older and duplicate snapshots ignored. No message-history
scan, local re-pricing, or per-message accumulation is needed. The estimate belongs
to the current thread and provider instance; account snapshots and the cross-thread
usage cache cannot supply it. Free-model sessions can report `$0.00` without login.
Older runtimes that omit the native cost show **not reported**, rather than zero.

This is not a remaining balance or account allowance. OpenCode's documented server
API does not expose those. Settings explains where to find session usage; no
account-refresh action is offered. The shared client parser supports web/desktop
and mobile web. The native mobile client currently has no provider usage bar.

## Jev Free: preliminary support

Jev is TypeSafe's System One decision model. It returns typed decisions and
probabilities, rather than conversational text or code. Keep a coding model
selected in OpenCode and ask the agent to use **`jev_decide`** when a structured
decision is useful. Jev entries are excluded from the coding picker, and a direct
attempt to start a conversation with a Jev model returns an explanatory error.

The tool is included in Solla's authenticated host MCP server and is also callable
through the existing shell bridge. It works with OpenCode and other providers
that use these host tools; web, desktop, and mobile show the ordinary tool result.
It evaluates only the supplied state and questions, without reading files or
gathering thread history automatically.

Example tool arguments:

```json
{
  "state": "The add function now returns a + b. Its tests passed.",
  "questions": {
    "passed": { "type": "noul", "instructions": "Did the tests pass?" },
    "operation": {
      "type": "choice",
      "instructions": "What operation does the function perform?",
      "criteria": { "add": "Addition", "subtract": "Subtraction" }
    },
    "status": {
      "type": "score",
      "instructions": "How complete is the fix?",
      "criteria": ["Broken", "Fixed but untested", "Fixed with passing tests"]
    }
  }
}
```

This initial version accepts text state and text rubrics. Serialize structured
state as text. It allows 32 questions, up to 255 choice options, and 2–10 score
levels. Requests and responses are each capped at 256 KiB with a 30-second request
deadline and caller cancellation. Responses must match the requested questions,
types, option sets, probability ranges, and score bounds before they are returned.
Probabilities express uncertainty; the tool does not make subsequent decisions or
override the coding agent's permission rules.

### Access and cost (checked September 21, 2026)

[OpenCode Zen documents](https://opencode.ai/docs/zen/#jev) the limited-time free
model **`jev-1.13-free`** at `https://opencode.ai/zen/v1/systemone`. Solla's tool uses
only this model. It makes no automatic retries, subscribes to nothing, and never
falls back to the paid variant. In the live check, this endpoint accepted a
request without a key and returned `cost: "0"`; that is an observation of current
access, not a promise that keyless access will remain available. If access changes,
the tool reports the failure.

The paid `jev-1.13` variant is listed at $0.042 per million input tokens, with free
output, under Zen's pay-as-you-go pricing. A paid subscription was not needed for
the tested free route. Direct TypeSafe access is separate and requires an API key.
See [TypeSafe's coding-agent guidance](https://docs.typesafe.ai/introduction/coding-agents)
and [API reference](https://docs.typesafe.ai/api).

### Maintainer smoke test

```sh
SOLLA_RUN_FREE_OPENCODE_SMOKE=1 node apps/server/integration/opencode-free-smoke.ts
```

This opt-in test uses a disposable workspace and isolated OpenCode configuration
and data directories. It verifies Big Pickle's zero-cost catalog metadata before
starting the coding turn, fixes and tests a tiny fixture, then checks a follow-up
turn and a mixed Jev decision request. It retains its evidence directory and
closes its own OpenCode server. It does not use the live Solla database. This is a
small integration check, not a model-quality benchmark.
