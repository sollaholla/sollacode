# Provider usage goes stale (Codex "Unavailable", AGY "Stale")

Status: **partially fixed in 0.1.535. The structural fix is designed, not built.**

## What the owner sees

- Codex usage card: **Unavailable**, "Couldn't refresh right now. Showing the last confirmed
  usage while Solla Code retries", and `—` in the composer meter.
- AGY usage card: **Stale**, "Last reported Sep 11 at 6:17 PM" — roughly an hour old.

## What is actually wrong

Nothing is broken in the Codex CLI or our bindings. Driven by hand against codex-cli 0.154.0,
every layer answers correctly:

- `initialize` → fine.
- `account/read` → `{"account":{"type":"chatgpt","email":"…","planType":"pro"},"requiresOpenaiAuth":true}`.
- `account/rateLimits/read` → full payload, `usedPercent: 100` on the `codex` bucket.
- Decoding that exact payload with `V2GetAccountRateLimitsResponse` **succeeds**. The live
  response carries a field our generated schema does not know (`ordinaryUsageAllowed`), but
  Effect ignores excess properties, so this is not drift damage. Regenerating does not help
  either: `scripts/generate.ts` is pinned to an upstream commit, not to the installed binary.

The failure is a **budget**, and it is silent by construction:

1. `account/rateLimits/read` is NETWORK-backed — the app-server asks OpenAI for the account's
   limits. It is racing the owner's uplink (mobile, tailnet), not local IPC.
2. `CODEX_OPTIONAL_RATE_LIMITS_TIMEOUT` was **3 seconds**.
3. `settleOptionalCodexRateLimits` wraps it in `Effect.option` + `timeoutOption`, so losing that
   race produces `None` — no error, no log, no user-visible reason. Usage simply never arrives,
   the card says "Unavailable", and yesterday's number ages into "Stale".

And the trap that makes a naive fix worse: the whole probe is bounded by
`AUTH_PROBE_TIMEOUT_MS = 10_000`, and the rate-limits call runs **inside** it. Raising the usage
timeout to or above the probe budget lets a slow usage fetch consume the readiness check, turning
"usage is late" into "the provider failed to refresh" — the louder bug.

## Shipped now (0.1.535)

`CODEX_OPTIONAL_RATE_LIMITS_TIMEOUT` 3s → **7s**: a real network round trip, still three seconds
clear of the probe budget. This makes the common case work. It does not make usage _reliable_.

## The structural fix (not built)

Usage must not be fetched inside the readiness probe at all. While it is, every usage refresh is
capped by a budget sized for a health check, and every slow network answer is either discarded
silently or charged against readiness.

1. Move usage collection to its own periodic task, off the probe, with its own generous budget
   and its own retry — so a slow answer delays only the number.
2. Record _why_ a refresh failed instead of collapsing it to `None`, and surface that on the card.
   "Unavailable" with no reason is what made this invisible for so long.
3. Refresh on a schedule rather than only when a probe happens to run. AGY's "Stale" is the same
   shape: usage arrives as a side effect of other work, so a provider nobody is actively using
   simply stops reporting.
4. Treat the existing carry-forward (`makeManagedServerProvider`) as display of last-known state,
   which it already is — but pair it with a real age and a real reason.

Until (1) and (3) exist, usage can still go stale whenever the network is slower than the budget
or no probe runs.
