# Provider usage-limit failover

Solla Code automatically continues a thread on another configured provider when the active provider
reports that its account usage limit is exhausted.

## Supported limit signals

Failover is deliberately based on typed provider events rather than matching error text:

- Codex: `account/rateLimits/updated` reports an explicit reached type, reached spend control, or a
  primary/secondary window at 100% usage.
- Claude Code: the SDK `rate_limit_event` reports `rate_limit_info.status: "rejected"`.
- Cursor, Grok, and OpenCode: no automatic usage-limit failover until their adapters expose a typed
  canonical account-limit event. Their ordinary provider errors do not trigger a switch.

Warnings and near-limit notifications do not trigger failover. The event must also belong to the
provider instance currently bound to the thread, so a delayed event from an old session cannot move
the thread.

## Choosing the next provider

Solla Code reads the configured provider snapshots in their stable registry order. A candidate must be
enabled, installed, available, not in an error/disabled state, not explicitly unauthenticated, and
advertise at least one model. Solla Code prefers the first eligible provider using a different driver,
then falls back to another instance of the same driver. The provider's default advertised model is
used, or its first advertised model when no default is marked.

An instance that exhausted its limit is not reused by that thread for 24 hours in the current server
process. If every eligible instance is exhausted or unavailable, the work log records that no
failover target is available.

## JSON handoff behavior

The exhausted provider is never asked to generate a summary. Instead, Solla Code creates a
deterministic JSON context digest from the thread history already persisted by T3. This avoids
depending on a provider that is rejecting requests and avoids an uncontrolled large completion.

The JSON includes the source and target provider instances, the limit reason/reset time, the thread
identity, and the newest persisted messages in chronological order. Its hard limits are:

- 32,000 characters after JSON serialization
- 24 messages
- 2,000 characters per message

The normal provider-turn contract accepts at most 120,000 input characters; the handoff uses the
smaller 32,000-character ceiling so it cannot approach that transport limit. Solla Code does not claim
an exact token count because each provider/model uses a different tokenizer. In particular, it does
not request or attempt a 100,000-token completion.

The digest records omitted and truncated message counts. If escaped content would exceed the final
32,000-character cap, Solla Code removes the oldest included messages and serializes again, so the
handoff always remains valid JSON under the cap. Attachments are represented only by their count;
binary attachment data is not copied into the handoff.

Solla Code starts the replacement session in the same thread, workspace, runtime mode, and interaction
mode, then sends the JSON as the replacement provider's first turn. The thread's selected provider
and model are persisted only after that provider accepts the handoff turn. If sending the handoff
fails after session startup, Solla Code attempts to restore the previous provider session from its
saved resume cursor and records the failure in the work log.
