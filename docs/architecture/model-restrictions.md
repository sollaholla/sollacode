# Model restriction enforcement

`ModelAccessPolicy` in `packages/contracts/src/settings.ts` is an exact provider-instance
and model allow/block list. Server settings store an environment `fallbackModelPolicy`
and a `threadModelPolicies` map. Updating one thread replaces its complete policy and
preserves other entries. Old settings decode to unrestricted defaults.

An agent's policy is attached to its durable root thread. Side chats inherit dynamically
through `sideChatParentThreadId`, rather than copying rules when a fork is created.
`packages/shared/src/modelAccessPolicy.ts` supplies predicates and client ancestry traversal.
The server resolver uses the projection query and fails closed for missing ancestry,
cycles, or excessive depth. A child allowlist cannot loosen its parent's restrictions.

`ProviderCommandReactor` checks thread rules before session setup and immediately before
every provider send, including live steering and recovery. Policy rejection is terminal
for that attempt, rather than a transient provider error eligible for silent retries.
`ProviderRuntimeIngestion` and deferred command recovery filter automatic candidates before
ranking. Ingestion rechecks after session startup and before rollback delivery; quota-reset
restoration also checks the global rule. Lookup failure never falls back to unrestricted
candidate selection. Provider adapters share this boundary, so these checks do not depend
on Codex, Claude, Cursor, Grok, OpenCode, or another driver's model naming conventions.

Web/Electron and native mobile expose the same policy modes and exact catalog identifiers.
The picker applies inherited thread rules while Settings exposes the global automatic rule.
The server remains authoritative for other clients, delayed commands, and direct API callers.
An already admitted turn is not interrupted when settings change, and a provider's internal
model routing is outside this enforcement boundary.
