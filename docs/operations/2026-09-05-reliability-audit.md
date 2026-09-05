# September 5 reliability audit

## Backend stalls with long thread history

Retained 0.1.429 server traces showed a synthetic-turn admission query blocking
the synchronous SQLite connection for up to 46.25 seconds. Its nested delivery
receipt lookup scanned the thread's activity events and parsed historical tool
payloads for each later message. Other requests waited behind that transaction.
Migration 074 adds a partial delivery-receipt index, and admission explicitly
uses it to find the relevant thread and message.

A separate completion query took 12.08 seconds while loading the whole thread's
activities. Resume-owner retirement now reads only finalized assistant output
for the completed turn, then checks indexed activity kinds if needed. It no
longer retrieves or decodes unrelated historical payloads. Attachment-only and
tool-only output still complete the owner; empty completions remain retryable.

An isolated SQLite fixture with 25,000 historical 8 KB tool payloads and 12
delivered follow-ups returned identical admission decisions before and after
the change. Admission fell from about 1,010 ms to 0.13 ms. The completion check
fell from about 1,092 ms to 4.3 ms and avoided retrieving 207 MB of payload JSON.
These are fixture measurements, not a production latency guarantee.

The installed database check exposed a planner difference that the fixture did
not reproduce: despite the turn filter, SQLite chose the thread-sequence index
for activity existence, taking 8.08 seconds. The follow-up explicitly selects
the existing turn-kind index and tests that query plan. The read-only check on
the same installed database then completed in 2.7 ms. Delivery admission
and assistant-message checks measured 3.4 ms and 1.1 ms respectively on the live
database; these checks did not dispatch work or change thread state.

The original early-morning freeze predates the retained server trace window.
Its exact cause cannot be established from those logs. The two stalls above
were measured in the installed runtime and reproduced independently; the OS
disk-write diagnostic alone does not establish a crash or an out-of-memory
failure.

## Windows could not list the Mac's agents

The saved Mac connection authenticated over both LAN and Tailscale. Its agent
subscription failed with `EnvironmentAuthorizationError` requiring
`vm:operate`. The Mac had five registered agents.

An earlier session had the agent permission added by migration 052. Renewing
that device credential subsequently copied the original signed token's old
scope list, dropping the saved grant. Renewal now uses persisted scopes, as
verification and WebSocket ticket validation already do. Tests cover both
added agent access and later restrictions.

Migration 075 repairs only unrevoked Nearby bearer sessions with the exact
legacy standard scope set and an earlier matching unrevoked session containing
the agent grant. Custom credentials, restricted scopes, revoked sessions, and
connections without that prior grant are preserved. Existing credentials use
the repaired grant after the host restarts and the client reconnects.

## Verification boundaries

Focused tests cover query plans, admission semantics, retirement without
historical payload decoding, credential renewal, and migration exclusions.
Windows-to-Mac HTTP authentication and the actual agent WebSocket subscription
provide the installed-runtime check. The user requested code and release
checks only, so this audit does not claim visual client verification.

## Mobile navigation and agent panel follow-up

The mobile web header's redundant Settings shortcut is removed; Settings stays
in the navigation sidebar. The agent header now calls the right sidebar
**Panel**, and its toggle stays available with no browser tabs. Opening it
preserves the selected surface or shows the empty chooser.

Completed side-chat work restoring Terminal and Side Chat beside Browser had
remained uncommitted and was excluded from the reliability-only packages. The
follow-up integrates that work into both the inline panel and narrow-screen
sheet. Agent terminal actions use the right panel and side-chat creation keeps
the parent agent in view.

Forced browser creation is removed from the empty-panel effect, server close
operation, and legacy close reconciliation. Named-agent final-tab and batch
closes emit only closure events and remain empty across a server restart.
Existing tabs and browser profiles are preserved. Native mobile's separate
navigation is unchanged.

## Persistent chats incorrectly classified as settled

The installed Orchestrator and Agent Builder rows had no saved settled override.
The shared client inactivity rule treated them as ordinary work threads. The
client now exempts the reserved Orchestrator id and Agent Builder id prefix
from every settlement source, including stale explicit overrides. This shared
rule covers web, desktop, and native mobile lists, plus the web chat banner.
The server rejects explicit settle commands for the same identities, including
requests from older clients. Ordinary delegated task threads remain eligible
for settlement. No live database edits were needed.
