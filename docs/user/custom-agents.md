# Custom agents

Custom agents are the named agents in the **Agents** section. Each one owns one dedicated conversation. They are separate from ordinary coding threads and from the orchestrator.

Each newly created agent also receives its own durable working directory below the environment's
agents folder. Its files and local instructions, including an agent-specific `AGENTS.md`, no longer
land in the directory shared by every other agent. On upgrade, an existing agent is pointed at a
deterministic dedicated directory and its shared-root `AGENTS.md` is copied only when the new
directory has no rules file. Other ambiguous legacy files stay untouched at the old shared root.

When an agent consults a project by opening a new thread, that thread is marked with an agent icon. A shared-browser indicator appears on both the thread and browser toolbar.

Every thread and agent in an environment shares one browser profile: the same cookies, logins, storage, and HTTP cache. Signing into a site once — in any thread, or in the agent's own panel — signs in everywhere in that environment, which is what lets an agent act on the sites you are already signed into. Profiles used to be per thread, so each conversation opened an empty cookie jar and an agent read a site as signed out while you were signed in one thread over. Separate environments still keep separate profiles: a remote machine's browser is that machine's browser.

### If the browser reads as signed out on macOS

Chromium keys its cookie store on a Keychain item named `<product> Safe
Storage`. Installs that predate the rename from `t3code` still hold
`t3code Safe Storage`, and nothing ever created `Solla Code Safe Storage` — so
the browser writes every cookie in plaintext and does not apply stored logins.
Sites then read as signed out in every tab, and a sign-in lasts only until the
app restarts. Create the key once and restart:

```sh
security add-generic-password -a "Solla Code" -s "Solla Code Safe Storage" \
  -w "$(openssl rand -base64 16)" -T "/Applications/Solla Code.app" -U
```

Sign in once afterwards; the session then persists and every thread and agent
sees it. Windows stores this key through DPAPI and is unaffected.

## Workspace views

Opening an agent goes directly to its conversation. The header keeps only contextual controls:

- **Chat** is the agent's single persistent conversation and primary workspace. A follow-up waits behind active work; it does not create a parallel session.
- **Activity** is on demand under the agent tools menu. It contains bounded handoff history, questions, results, follow-ups, and cancellation controls. New delegation starts in Chat.
- **Scheduled work** is on demand under agent tools. It contains durable prompts that run manually, once, or at a minute interval. **Build with AI** turns a plain-language request into a title, self-contained prompt, schedule, completion criteria, and notification policy using the configured **Utility AI model**. It does not silently fall back to Codex merely because the agent has a Codex-compatible workspace.
- **Dashboard** appears only when the agent owns a meaningful view such as metrics, a checklist, a table, a timeline, cards, or an HTML/CSS web surface. The default schedule view is omitted because it duplicates Scheduled work.
- Waiting-on-you requests and independent alerts share one compact stack at the live end of Chat. The newest card stays visible and hovering or focusing it reveals one more card, so attention never becomes a wall across the workspace. Waiting-on-you cards keep their Open, Follow up, resolve, and dismiss actions there. Follow up references that request in the composer for a correction without resolving it. Completions, failures, and direct informational messages raise an unread bell on the agent row; opening that agent scrolls the newest alert into view and marks it read only once its card is visible. There is no separate inbox to manage.
- **Browser** is a contextual side-panel control. It appears when the agent has browser tabs, a remote window, or an open browser panel instead of occupying a permanent peer tab.

On mobile, tapping an agent opens Chat directly. The trailing details control opens agent identity
and an on-demand **Delegated activity** section, so collaboration history is not subscribed or
rendered until it is requested.

Tasks, notifications, and collaboration state are stored by the environment. Web, desktop, and
mobile group agents by their connected host, so a phone connected over LAN, relay, or Tailscale can
open the same named agent and its dedicated chat. An environment-qualified agent link never silently
switches to an agent with the same id on another host.

## Browser tab lifecycle

An agent's browser sidebar always retains one tab. Closing the final page replaces it with a blank
tab instead of showing the general surface picker, and that blank tab survives an app restart.
Ordinary chats are not browser-only: closing their final browser tab returns to the complete surface
picker for Browser, Terminal, Files, Diff, and Side Chat.

Links that explicitly target a new browser tab open as a sibling Solla Code browser tab in the same
thread. The original page stays in place, and the new tab is persisted and selected like one opened
with the Browser `+` control. OAuth-style popup windows remain real child windows so sign-in flows
can communicate with and return to their opener; popup permission is present when Electron creates
the guest rather than being added after its first navigation.

The desktop guest uses the native user agent produced by its bundled Electron and Chromium runtime,
along with the real platform, languages, cookies, cache, and storage. Solla Code does not rewrite
that value: even removing an embedded-app token changes the browser integrity signal and can break
production verification. It does not invent a Chrome version, spoof a device fingerprint, hide
automation from a site, or bypass CAPTCHA and anti-abuse decisions.

Preview guests stay mounted and unthrottled while their owning window, thread, or tab is in the
background, so timer- and animation-frame-based authentication can finish without the user focusing
each surface. Desktop guest lifetime is independent of transient server tab metadata: reconnecting
the preview stream does not recreate the Chromium guest or change its browser profile. Background
guests retain their full last-known geometry behind the opaque app shell at compositor-active
opacity, so a newly opened page starts loading before its thread or tab is selected without being
clipped, resized, or stacked over chat and files. A native snapshot fallback briefly raises the
same geometry into the compositor; selecting a tab changes only its presentation, and
automation preserves the fill-the-panel viewport unless the user or tool explicitly resizes it.
When preview automation connects or begins an MCP operation, Solla Code makes every registered
preview tab foreground-equivalent before running that operation and renews the fleet-wide lease
throughout long-running operations. The lease is released one minute after the last operation
finishes; the next connection or operation reactivates every tab before continuing. Automation
snapshots capture only that live guest. They never reload an authenticated URL in a second renderer;
if the page changes while its pixels and semantic state are being read, Solla Code retries the live
capture once and otherwise returns the latest text and controls without a misleading stale image.

Before an agent has selected a tab, its preview tools bind to the visible interactive Browser
surface in the same environment when that surface belongs to the same browser profile or to an
ordinary user thread. They do not take over another custom agent's tab. An explicit `tabId` from another
agent is rejected with an error telling the caller to use this agent's own tabs and not reuse
other agents' tab IDs. Opening a new tab from a valid visible user surface keeps it in that
browser's profile, so the user's authenticated session does not silently become an empty
thread-local session. `preview_open` with the default `open: true` selects that tab in the
thread's Browser panel so the user and the agent are looking at the same guest, cookies, and
login; it does not leave the agent's tab in a hidden mini-player while the panel stays on a
different page. An explicitly selected tab stays pinned only when it belongs to this
agent's profile. When no reusable browser surface is visible, automation falls back to the
requesting thread's own tab, which is on the same shared profile.

Custom agents and their delegated workers use this built-in collaborative browser as their browser-
control surface. Computer control, Chrome or browser-extension control, and standalone browser
automation are not fallbacks for a closed preview, a failed tool call, or a login/profile mismatch.
The agent keeps the relevant page open here and raises a blocker when the user must sign in or
complete another human-only step. If the built-in preview is unavailable, it reports that limitation
or raises a blocker instead of substituting a different browser-control surface.

Cloudflare Turnstile, CAPTCHA, and comparable anti-bot pages are explicit human handoffs. When the
preview detects a `300*` or `600*` challenge-family error, a visible Turnstile failure, or a
Cloudflare-mitigated Challenge Page, it pauses agent interaction for that tab and keeps the same
profile, cookies, page, and network path staged for the user. The user completes the page manually
and chooses **Check again** before automation can resume. **Check again** performs a read-only page
inspection; it does not refresh or retry the challenge. Solla Code does not spoof browser APIs,
hide automation, rotate network identity, or automate production challenges. Because the preview is
an embedded Chromium surface with automation attached, manual completion is best-effort; the card
links to Cloudflare's official compatibility checker and feedback process. Remote clients can still
view and manually control the staged tab, while detection and the automation gate are enforced by
the desktop host that owns the browser process.

Websites that need a local file use the built-in `preview_upload` action. The agent supplies a known
absolute path and targets the page's file input; Solla Code validates the file and attaches it through
the collaborative browser without opening the operating-system picker or taking over the desktop.
The agent then submits the page and verifies the visible upload result in the same tab.

The browser tools also make tab ownership explicit. Before opening another page on a domain that is
already present, the agent receives the matching tab IDs and must either select one to reuse or
explicitly request a separate tab. A newly created tab comes with its exact cleanup call; the agent
closes it when that browsing concern is finished. Reused tabs are never closed merely as cleanup,
and `preview_close` removes the thread-owned tab session rather than merely closing the guest page.
After a successful turn changes the open-tab set, one compact housekeeping prompt asks the agent to
review only its newly created tabs; unchanged, failed, cancelled, interrupted, and cleanup turns do
not create another prompt.

Only the browser tab visibly selected in the sidebar can play audio. Background tabs and floating
preview windows remain muted; a floating window does not grant audio permission by itself. When an
inactive tab has a floating preview or picture-in-picture window open, its favicon changes to a blue
cast icon so the remote view is still obvious.

## Collaboration

The on-demand **Activity** view is a bounded handoff workspace. Its list and conversation panes
scroll independently, and narrow windows switch between them with a Back action, so a long request
or result never stretches the surrounding app. New handoffs are requested naturally in Chat rather
than through a second composer.

- A root agent can ask another named agent for help or create a short-lived ephemeral sub-agent.
- Incoming delegated tasks run in separate worker chats, including tasks addressed to a named agent.
  The named agent's main conversation keeps its own messages and active turn. Canceling or expiring
  a delegation stops its worker; it does not stop unrelated work in the main conversation.
- Delegation is requested through the root chat, so normal tools and approval policy remain in
  control. The UI does not create work behind the root agent's back.
- Questions from a worker appear as **Waiting for your answer**. Replies, delivery state, completed
  results, and cancellation are visible in the delegation detail.
- Long briefs, questions, results, errors, and messages open on demand inside bounded readers. Reply
  drafts are retained per handoff while switching between conversations.
- The newest conversation page arrives with the handoff. **Show earlier messages** loads older
  pages on demand, so an active collaboration does not repeatedly transfer its full history.
- A delegation that is **Pending approval** must be opened in the root chat and approved by a human.
  It is never auto-approved by the collaboration view.

Named collaborators and ephemeral workers are scoped to one environment. Cross-host delegation is
not inferred from a matching name or handle.

## Scheduling and approval

A user-created task is approved immediately. A custom agent can use its `agent_workspace` tool to create or update tasks on the user's behalf:

- One-off work can be activated by the agent.
- Recurring work created or materially changed by the agent is always saved as a draft with **approval needed**. Select **Approve** in Scheduled work before it can run.

The server scheduler is independent of an open page. When work becomes due it:

1. claims one task for that agent;
2. waits if the dedicated conversation is already running;
3. sends the saved prompt to the dedicated conversation;
4. records the result and notification.

Claims and run identifiers survive a server restart. A missed repeating interval advances to the next interval rather than launching a burst of catch-up runs. At most one scheduled run is active per agent.

## Notifications

Agent policy independently controls completions, failures, and direct agent messages. Direct agent messages are limited to ten per hour. Task notification policy can be **always**, **failure**, or **never**.

A **Waiting on you** request is already durable user attention, so it never also creates an inbox or desktop notification. Agent instructions reserve `notify_user` for independent informational updates that require no user action and explicitly forbid pairing it with `report_blocker`. Environments upgrading from an older build remove the obsolete `blocker:*` notification copies during migration.

Native desktop delivery is a separate, per-device opt-in under **Settings → Agents → Desktop agent alerts**. Enabling it is the only path that requests operating-system or browser permission. An unfocused agent can send a native alert only when both that setting and the host permission are already granted; denied, undecided, and unsupported clients make no delivery attempt. The durable in-chat alert remains available either way.

The Agents list shows a numbered notification bubble for each agent's unread, unarchived alerts. A raised-hand icon means that agent has at least one unresolved **Waiting on you** request. A spinning dashed circle means the agent's chat is mid-turn right now. These indicators are scoped to their owning environment and update without downloading every agent's message body.

## Artifact safety

The Dashboard can be a structured view (schedule, metrics, checklist, table, timeline, or cards) or
an HTML/CSS web surface. Structured views stay data-only. An `html` artifact renders in the same
opaque iframe sandbox as a [thread web artifact](./thread-artifacts.md): scripts may run inside the
frame, but popups, downloads, forms, same-origin privilege, and top-level navigation stay blocked.
Keep the page self-contained — inline CSS, or pass it in the optional `css` field; do not depend on
workspace files or remote assets that the sandbox cannot load.

This custom-agent **Dashboard** is not a [thread artifact](./thread-artifacts.md). A thread
artifact is a revisioned file bundle published by any chat. The custom-agent artifact is one
workspace view owned by that named agent, including an HTML dashboard when the agent needs a real UI.
