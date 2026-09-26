# Provider usage-limit failover

Solla Code automatically continues a thread on another configured provider when the active provider
reports that its account usage limit is exhausted.

## Supported limit signals

Failover is deliberately based on typed provider events rather than matching error text, with two
narrow exceptions (below):

- Codex: `account/rateLimits/updated` reports an explicit reached type or reached spend control.
  Codex can also refuse a turn as error text ("You've hit your usage limit …") while its typed
  snapshot still reads `rateLimitReachedType: null`; that refusal fails over only when the latest
  stored snapshot shows a primary/secondary window at 100% usage with no fallback credit behind it
  and a reset still in the future. Neither the refusal text nor the 100% window triggers alone.
- Claude Code: the SDK `rate_limit_event` reports `rate_limit_info.status: "rejected"`.
- Grok: `_x.ai/billing` reports `creditUsagePercent` at 100% for the current SuperGrok weekly pool.
- Deep Code: the adapter's progress watchdog stops a turn whose session file sits unchanged for
  five minutes and fails over on its exact stall marker. No quota snapshot corroborates it — the
  measured silence is the signal — and the account rests thirty minutes before the thread may
  return to it.
- Cursor and OpenCode: no automatic usage-limit failover until their adapters expose a typed
  canonical account-limit event. Their ordinary provider errors do not trigger a switch.

Warnings and near-limit notifications do not trigger failover. The event must also belong to the
provider instance currently bound to the thread, so a delayed event from an old session cannot move
the thread. A spent Codex window with no fallback credit also screens that instance out when
choosing a failover target, so a thread is never handed to a Codex account that just refused one.

## Transient upstream retries

Temporary upstream failures do not trigger a provider switch. Solla retries them up to 15 times
without surfacing the error, waiting 1, 2, 4, 8, then 15 seconds between retries. All remaining
backoff waits stay capped at 15 seconds; after the budget is exhausted, the error becomes visible.
This cap applies to Solla's retry scheduler, not the provider's own internal retries or request timeouts.
OpenCode also stops a parent or subagent session after 15 consecutive empty completed responses.
A parent empty-response failure enters the same bounded silent recovery instead of appending a
Runtime error card on every attempt. A child failure stops only that subagent.

## Choosing the next provider

[Model restrictions](./model-restrictions.md) are applied before candidate ranking. The
environment's automatic-fallback rule, the thread's rule, and every ancestor's rule must
all allow the exact provider account and model. These checks also apply to same-provider
downshifts and automatic quota-reset restoration. If no permitted candidate remains, the
thread stops; it does not bypass the restrictions. Rules are checked again before the
handoff message is sent, including changes made while a provider session was starting.

When the exhausted provider still has another advertised model with remaining quota, Solla Code stays
on that instance and switches to the next-highest remaining model. Claude Fable 5 therefore fails
over to Claude Opus 5 with High effort instead of jumping to Codex. Shared Claude windows such as the
five-hour session or weekly cap still leave the whole Claude instance.

If that instance has no remaining model, Solla Code reads the configured provider snapshots in their
stable registry order. A candidate must be enabled, installed, available, not in an error/disabled
state, not explicitly unauthenticated, and advertise at least one model. Solla Code prefers the first
eligible provider using a different driver, then falls back to another instance of the same driver.
Claude and Antigravity select the highest usable advertised Claude model (Fable, Opus, Sonnet,
then Haiku, newest version first within each tier), including secondary-model retries. Antigravity's
Gemini and Claude/GPT quota pools are checked separately, so an exhausted Gemini default does not
preempt usable Claude. Exhausted pools are skipped until their reset. Other providers use their
default advertised model, or their first advertised model when no default is marked. If starting or handing off to a candidate fails, Solla Code tries the next remaining
candidate rather than stopping on the first failure.

An exhausted model is not reused by that thread for 24 hours in the current server process. An
instance is skipped for further provider-level search once it has no remaining models or reports an
account-wide limit. Failover continues through every remaining enabled provider; when none remain,
the work log records that no failover target is available and the thread stops.

Successful automatic switches show the model/provider switch notice without a duplicate Runtime error card. This also applies to saved error rows linked to a successful failover receipt. If no provider can continue, the usage-limit notice explains why the thread stopped; unrelated errors still appear.

A provider that cannot run the turn at all, such as one that rejects the request as invalid, also moves the thread. The message it rejected is then delivered on the provider the thread moved to, with one switch notice. It is not treated as a failed manual switch. Grok never sends a model its CLI no longer lists: a retired model id, or an effort level the model does not offer, falls back to what the Grok session advertises.

When a message's turn fails for good (for example, a manual provider switch the new provider rejects), the message is labelled **Not sent** instead of "Queued for …". Hover the label to see the provider's reason. **Send again** sends the same message on the thread's current provider and model, so after a failover it goes to the provider the thread moved to. The button appears only on your newest message, and only when nothing is running or queued that could still deliver it. A message that already reached a provider is never sent twice.

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

The replacement remains marked as working while it runs, including when the old provider takes
longer to stop. Stop checks the running provider even if the chat's status has fallen out of sync.
The handoff reminder asks the new agent to check its current tools before relying on an earlier
session's report of missing tools or rejected credentials. The reminder is provider-aware: Codex,
Claude, Cursor, Grok, and OpenCode mount Solla's t3-code MCP server, so for them it names the
thread-history tool for reading the omitted transcript. Deep Code, Antigravity, and external bridges
never receive that server, so for them the reminder points at the workspace (files, git history,
focused tests) instead and says not to report being blocked or ask the user to re-supply context the
digest already carries.
