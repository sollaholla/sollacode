# Custom agents

Custom agents are the named agents in the **Agents** section. Each one owns one dedicated conversation whose collaborative browser keeps its own persistent logins. They are separate from ordinary coding threads and from the orchestrator.

When an agent consults a project by opening a new thread, that thread is marked with an agent icon. Its browser keeps separate tabs but intentionally reuses the creating agent's cookies, storage, and HTTP cache so authenticated work can continue without another sign-in. A shared-browser indicator appears on both the thread and browser toolbar; ordinary user-created threads remain isolated.

## Workspace views

Open an agent and use the tabs in its header:

- **Chat** is the agent's single persistent conversation. A follow-up waits behind active work; it does not create a parallel session.
- **Tasks** contains durable prompts. A task can be manual, run once at a specific time, or repeat at a minute interval. **Build with AI** turns a plain-language request into a title, self-contained prompt, schedule, completion criteria, and notification policy using the agent thread's selected provider and model.
- **Artifact** is one structured surface owned by the agent. The initial Schedule artifact follows task and run state automatically. An agent can replace it with metrics, a checklist, a table, a timeline, or cards.
- **Inbox** contains durable notifications from task runs and the agent. Its message list shows subjects and previews beside a Markdown-rendered reading pane. Opening a message marks it read; it can be marked unread again, archived when finished (with confirmation, singly via each row's checkmark or in bulk through multi-select), or restored to the inbox. Archived messages are deleted 48 hours after they were archived. With browser notification permission, new items also appear as desktop notifications while Solla Code is running.

Tasks, notifications, and collaboration state are stored by the environment. Web, desktop, and
mobile group agents by their connected host, so a phone connected over LAN, relay, or Tailscale can
open the same named agent and its dedicated chat. An environment-qualified agent link never silently
switches to an agent with the same id on another host.

## Browser tab lifecycle

An agent's browser sidebar always retains one tab. Closing the final page replaces it with a blank
tab instead of showing the general surface picker, and that blank tab survives an app restart.

Custom agents and their delegated workers use this built-in collaborative browser as their browser-
control surface. Computer control, Chrome or browser-extension control, and standalone browser
automation are not fallbacks for a closed preview, a failed tool call, or a login/profile mismatch.
The agent keeps the relevant page open here and raises a blocker when the user must sign in or
complete another human-only step. If the built-in preview is unavailable, it reports that limitation
or raises a blocker instead of substituting a different browser-control surface.

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

The **Collaborate** view is a bounded handoff workspace. Its list and conversation panes scroll
independently, and narrow windows switch between them with a Back action, so a long request or
result never stretches the surrounding app. **New handoff** opens a focused target picker; named
agent availability and capabilities stay visible there without crowding the active conversation.

- A root agent can ask another named agent for help or create a short-lived ephemeral sub-agent.
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
- Recurring work created or materially changed by the agent is always saved as a draft with **approval needed**. Select **Approve** in Tasks before it can run.

The server scheduler is independent of an open page. When work becomes due it:

1. claims one task for that agent;
2. waits if the dedicated conversation is already running;
3. sends the saved prompt to the dedicated conversation;
4. records the result and notification.

Claims and run identifiers survive a server restart. A missed repeating interval advances to the next interval rather than launching a burst of catch-up runs. At most one scheduled run is active per agent.

## Notifications

Inbox preferences independently control completions, failures, and direct agent messages. Direct agent messages are limited to ten per hour. Task notification policy can be **always**, **failure**, or **never**.

Browser/desktop notifications require permission from the operating system or browser. The Inbox remains the durable source of truth when permission is denied or no client is open.

The Agents list shows a numbered notification bubble for each agent's unread, unarchived inbox items. A raised-hand icon means that agent has at least one unresolved **Waiting on you** request. A spinning dashed circle means the agent's chat is mid-turn right now. These indicators are scoped to their owning environment and update without downloading every agent's message body.

## Artifact safety

Artifacts are declarative data, not agent-authored HTML or JavaScript. The UI only renders the supported schedule, metrics, checklist, table, timeline, and cards shapes. This keeps artifacts portable across local, remote, and tunnel connections without running arbitrary code.

This custom-agent **Artifact** tab is not a [thread artifact](./thread-artifacts.md). A thread
artifact is a revisioned file bundle published by any chat and may contain an isolated web preview;
the custom-agent artifact is one declarative workspace view owned by that named agent.
