# Custom agents

Custom agents are the named agents in the **Agents** section. Each one owns one dedicated conversation. They are separate from ordinary coding threads and from the orchestrator.

## Creating your first agent

While a computer has no agents, the sidebar's **Agents** section shows **Meet your agents**. It
opens a short intro (the **New agent** button opens the same intro until the first agent exists):

1. **Meet your agents** introduces what agents do: scheduled jobs, their own browser, and
   checking in with you.
2. **Pick a character** shows the whole cast. Each character looks up when you point at it and
   smiles when chosen; the character's name ("Mochi", "Lantern", …) becomes the suggested agent
   name.
3. **What should it do?** takes a name and a purpose. Starter buttons fill in a purpose (Research
   scout, Release watcher, PR babysitter, Daily digest), or you can write your own. The preview
   character reacts while you type. **Build one with AI instead** opens the Agent Builder chat.
4. The new agent cheers once, and **Say hello** opens its chat.

The animations play once and are off when the device asks for reduced motion. Later agents use the
plain **New agent** dialog, and the server gives each one the next free character. The phone app
can't create agents yet; its empty Agents screen points to the computer.

## Characters

Each agent gets its own character: a vivid body shape (mochi, bell, acorn, lantern, sunburst,
gumdrop, onion, capsule, pebble, dango or star), a face, and sometimes an ink accessory: goggles,
a scarf or a monocle. Your first eleven agents each get a different
shape, and your first fourteen each get a different color. The character follows the agent's
permanent identity across web, desktop and mobile, including renames and changes to its
conversation or coding provider.

The face shows what the agent is doing: focused while it works, looking up when it is waiting
for your approval or answer, worried after a failed turn, and smiling when it has finished work
you haven't opened yet. Offline characters turn a muted grey and fall asleep. The phone shows
the working and waiting faces.
A green dot means the agent is running and this client is connected to its environment;
a gray dot means it is stopped, starting, failed, or the environment is disconnected.
Work-in-progress and unread-alert indicators remain separate from online status.
Online characters occasionally hop and sway, and blink roughly every 3–5 seconds with
different, staggered rhythms and occasional double blinks.
They rest between gestures, stay still offline, and respect the device's reduced-motion
setting. Web characters also pause when offscreen or when the page is hidden; mobile
characters pause when the app is in the background.

Each newly created agent also receives its own durable working directory below the environment's
agents folder. Its files and local instructions, including an agent-specific `AGENTS.md`, no longer
land in the directory shared by every other agent. On upgrade, an existing agent is pointed at a
deterministic dedicated directory and its shared-root `AGENTS.md` is copied only when the new
directory has no rules file. Other ambiguous legacy files stay untouched at the old shared root.

An agent's `AGENTS.md` has a budget of 100,000 characters. Agents can grow the file themselves, and
Claude loads everything its `CLAUDE.md` imports, so an oversized file used to put every new Claude
session over the context limit before it could start (or, on a model with a larger window, made
Claude's automatic compaction give up with "Autocompact is thrashing"). When the file goes over budget, the agent's
`CLAUDE.md` imports a generated `AGENTS.loaded.md` instead. That file holds the first 100,000
characters and a note giving the full size. Each turn, the agent is also told to compact the file.
Codex already reads only the first 32 KiB. Solla Code never trims `AGENTS.md` itself. Once the file is
back under budget, the full import returns and the generated copy is deleted.

If a provider rejects even a fresh session before it does any work, the thread stops with an
explanation instead of starting new sessions that fail the same way. The usual cause is a large
instruction file or a very long message.

When an agent consults a project by opening a new thread, that thread is marked with an icon whose tooltip names the agent. Threads opened by an ordinary chat are marked the same way with that chat's title; see [Messages between chats](./cross-thread-messages.md). A shared-browser indicator appears on both the thread and browser toolbar.

Every thread and agent in an environment shares one browser profile: the same cookies, logins, storage, and HTTP cache. Signing into a site once — in any thread, or in the agent's own panel — signs in everywhere in that environment, which is what lets an agent act on the sites you are already signed into. Profiles used to be per thread, so each conversation opened an empty cookie jar and an agent read a site as signed out while you were signed in one thread over. Separate environments still keep separate profiles. When another device connects to an environment, it displays and controls the environment-owning desktop's browser frame so cookies, login state, and the live page remain identical.

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

On web and desktop, the header controls use transparent backgrounds and outlines in both themes. Build, Open, Git actions, Start/Stop, and Panel share the agent icon’s rounded corners and spacing; split-button menus retain their separate dropdown action.
The open Panel has a gold outline, and the remote-control icon uses the normal foreground color
so an available connection does not look disabled.

- **Chat** is the agent's single persistent conversation and primary workspace. A follow-up waits behind active work; it does not create a parallel session.
- **Activity** is on demand under the agent tools menu. It contains bounded handoff history, questions, results, follow-ups, and cancellation controls. New delegation starts in Chat.
- **Scheduled work** is on demand under agent tools. It contains durable prompts that run manually, once, or at a minute interval. **Build with AI** turns a plain-language request into a title, self-contained prompt, schedule, completion criteria, and notification policy using the configured **Utility AI model**. It does not silently fall back to Codex merely because the agent has a Codex-compatible workspace.
- **Dashboard** appears only when the agent owns a meaningful view such as metrics, a checklist, a table, a timeline, cards, or an HTML/CSS web surface. The default schedule view is omitted because it duplicates Scheduled work.
- Waiting-on-you requests and independent alerts share one compact stack at the live end of Chat. The newest card stays visible and hovering or focusing it reveals one more card, so attention never becomes a wall across the workspace. Waiting-on-you cards keep their Open, Follow up, resolve, and dismiss actions there. Follow up references that request in the composer for a correction without resolving it. Completions, failures, and direct informational messages raise an unread bell on the agent row; opening that agent scrolls the newest alert into view and marks it read only once its card is visible. There is no separate inbox to manage.
- **Browser** is a contextual side-panel control. It appears when the agent has browser tabs, a remote window, or an open browser panel instead of occupying a permanent peer tab.

On a phone-width web or desktop window, the agent's header is a card under the top bar. To give
Chat that room back, drag the agent's avatar up and to the right: it flies into the top bar's right
edge and the card folds away. **Collapse to top bar** in the agent tools menu (the agent's name)
does the same without a drag. Folded, the top bar keeps the avatar and **Panel**, so the Browser,
Terminal, and Side Chat sidebar stays one tap away. Tap the avatar to open the card again. The
choice is remembered for every agent on that device. Activity, Scheduled work, Rules, and Dashboard
always show the card, since it holds the way back to Chat. Wider windows keep the full header.

On mobile, tapping an agent opens Chat directly. The phone button beside it
[calls the agent](#calling-an-agent). The trailing details control opens agent identity
and an on-demand **Delegated activity** section, so collaboration history is not subscribed or
rendered until it is requested.

Tasks, notifications, and collaboration state are stored by the environment. Web, desktop, and
mobile group agents by their connected host, so a phone connected over LAN, relay, or Tailscale can
open the same named agent and its dedicated chat. An environment-qualified agent link never silently
switches to an agent with the same id on another host.

On web and desktop, **Actions** in the agent's Chat header offers the same project scripts as
ordinary threads. Run build, test, or other saved commands, add or edit actions, and import scripts
from the project's `t3.json`. Commands open in the agent's Terminal sidebar on its connected host.

## Sidebar surfaces

On web and desktop, an agent's right sidebar offers **Browser**, **Terminal**, and **Side Chat**.
Use **Panel** in the agent header to open or close it. Use **+** beside the tabs to add a surface,
then switch or close it from the tab strip. Terminal
shortcuts and working-terminal indicators open terminals in this sidebar; the agent's main column
stays on Chat. Side Chat requires a connected environment that supports side chats.

The same choices appear in the panel sheet on narrow windows. Native mobile keeps its existing
Chat and Browser navigation.

## Browser tab lifecycle

An empty panel shows the Browser, Terminal, and Side Chat choices. Opening the panel or closing
its last tab does not create a browser tab. Reopening the panel preserves its selected tab when
one is available. Adding a Terminal or Side Chat keeps the other tabs available beside it.

Links that explicitly target a new browser tab open as a sibling Solla Code browser tab in the same
thread. The original page stays in place, and the new tab is persisted and selected like one opened
with the Browser `+` control. The same applies to pages that open another page of their own site
from script, such as a list opening a record "in a new tab", and to any `noopener` window, which
gives the page no handle to keep. OAuth-style popup windows (sized or named windows, form posts,
another site's page, or a sign-in path on the same site) remain real child windows so sign-in flows
can communicate with and return to their opener; popup permission is present when Electron creates
the guest rather than being added after its first navigation. The child stays above its Solla Code
window, and preview status, snapshots, and input follow the child until it closes. Remote viewers
therefore see and control the current sign-in step instead of continuing to show the opener behind it.
One-time OAuth and SAML transaction URLs are never replayed after Solla Code restarts. Their durable
session entry points at the stable site origin instead, so a restored login starts a fresh transaction
and never persists an authorization code or state value in browser-tab state.

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
`preview_resize` completes only after both the saved viewport setting and the guest's measured CSS
viewport agree. The desktop host supplies that measurement when Electron temporarily rejects a
renderer-side webview read, so a successfully rendered phone or freeform viewport does not time out
and roll itself back to Fill.
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
  The agent's side chats act as the agent here, so they can delegate too.
- Incoming delegated tasks run in separate worker chats, including tasks addressed to a named agent.
  The named agent's main conversation keeps its own messages and active turn. Canceling or expiring
  a delegation stops its worker; it does not stop unrelated work in the main conversation.
- Delegation is requested in the agent's chat or one of its side chats, so normal tools and
  approval policy remain in control. The UI does not create work behind the root agent's back.
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

### Reaching an agent from any chat

Delegation stays with agents, but every chat can talk to one. An ordinary chat, a terminal agent CLI
or another agent finds the agent's chat (agent chats are marked in `workspace_consult`
`list_threads`, and `agent_collaboration` `list_agents` lists them) and messages it with
`workspace_consult` `ask`. The message arrives in the agent's chat under the sender's name, and
the agent's reply comes back as the answer to `ask`, or later through `read_thread`. A turn that
receives such a message asks you before any consequential action, even in Agent mode, and tasks it
adds or changes wait for your approval. Loop and rate limits are in
[Messages between chats](./cross-thread-messages.md#limits). A stopped agent's chat refuses messages
until you start the agent.

To be called by an agent from another chat, ask that chat to message the agent and have it use
`call_user`; see [When an agent calls you](#when-an-agent-calls-you).

## Scheduling and approval

A user-created task is approved immediately. A custom agent can use its `agent_workspace` tool to create or update tasks on the user's behalf:

- One-off work can be activated by the agent.
- Recurring work created or materially changed by the agent is always saved as a draft with **approval needed**. Select **Approve** in Scheduled work before it can run.
- A task the agent adds, or whose title, prompt, criteria or schedule it changes, while answering another chat's message or doing delegated work is saved as a draft with **approval needed** too, even one-off work. Only you can approve work another chat asked for; see [Messages between chats](./cross-thread-messages.md#approvals).

The server scheduler is independent of an open page. When work becomes due it:

1. claims one task for that agent;
2. waits if the dedicated conversation is already running;
3. sends the saved prompt to the dedicated conversation;
4. records the result and notification.

Claims and run identifiers survive a server restart. A missed repeating interval advances to the next interval rather than launching a burst of catch-up runs. At most one scheduled run is active per agent.

## Notifications

Agent policy independently controls completions, failures, and direct agent messages. Direct agent messages are limited to ten per hour. Task notification policy can be **always**, **failure**, or **never**.

A **Waiting on you** request is already durable user attention, so it never also creates an inbox or desktop notification. It can ring you as a call, though; see [When an agent calls you](#when-an-agent-calls-you). Agent instructions reserve `notify_user` for independent informational updates that require no user action and explicitly forbid pairing it with `report_blocker`. Environments upgrading from an older build remove the obsolete `blocker:*` notification copies during migration.

Native desktop delivery is a separate, per-device opt-in under **Settings → Agents → Desktop agent alerts**. Enabling it is the only path that requests operating-system or browser permission. An unfocused agent can send a native alert only when both that setting and the host permission are already granted; denied, undecided, and unsupported clients make no delivery attempt. The durable in-chat alert remains available either way.

The Agents list shows a numbered notification bubble for each agent's unread, unarchived alerts. A raised-hand icon means that agent has at least one unresolved **Waiting on you** request. A spinning dashed circle means the agent's chat is mid-turn right now. These indicators are scoped to their owning environment and update without downloading every agent's message body.

## Calling an agent

You can talk with an agent by voice, like a phone call. The call screen shows the agent's
character, its name, a timer and its buttons: **Mute**, **Add**, **Chat** and **End** on web and
desktop, **Mute**, **Add** and **End** in the phone app. A one-line caption shows the last thing
said. The agent can put you through to another agent, and you can bring other agents and chats
onto the call; see [Transferring a call](#transferring-a-call) and
[Adding others to a call](#adding-others-to-a-call).

Say goodbye to end a call by voice: once you say bye (or "that's all", "hang up") and the agent
answers with its own goodbye, the call hangs up as soon as that goodbye finishes. A connected call
ending, from either side, plays a short hang-up tone (off when sound cues are off in Settings).

A call sounds like a phone call. Calling an agent rings out until it picks up, and it answers
with a short hello such as "Hey, what's up?"; an agent that calls you opens with why it called. The
agent's voice comes down a phone line, cut to the range a handset carries, and while the agent works
in its chat you hear it typing in bursts of a couple of seconds, with pauses and the odd mouse click
in between. It stops typing whenever it speaks. The ringing and typing follow the sound cue switch
and volume. Turn the phone line and typing off on a device with **Settings → Appearance → Sound →
Phone-line calls**; the change applies from the next call. The phone app plays calls through the web
call page, so it gets the same sound, at the default settings.

Each agent speaks with its own voice. Left on **Automatic**, an agent gets one from its character,
so agents sound different from each other without anyone choosing, and the voice stays the same
from call to call. To choose one, open the menu on the agent's name and pick **Call voice**
on web and desktop, or tap **Call voice** under **Call** on the agent's screen in the phone app.
The list gives each voice's accent: Australian, British, Irish, North American, Filipino and
Southern U.S. English voices, plus two Brazilian Portuguese ones. Agent Builder can set it too. A
new voice applies from the agent's next call, and a transfer puts you through to the other agent's
own voice. On a group call everyone is heard in the voice of the agent you called.

The small arrow on **Mute** chooses the microphone. **Default** follows your system's microphone
and switches mid-call when it changes, such as when headphones connect. A microphone you pick is
remembered on that device and used again when it reconnects. If the microphone in use is unplugged,
the call moves to another one instead of ending. The same choice is in **Settings → Orchestrator →
Microphone**, and the orchestrator's voice uses it too.

Start a call from:

- **Call** (the phone icon) in the agent's header on web and desktop. It stays in the top bar when
  the header is folded on a phone-width window.
- **Call <agent>** in the command palette while an agent is open. **End call** appears there
  while a call is live.
- The phone app: **Call** on the agent's details screen, or the phone button on its row in the
  Agents list.

If the agent is already on a call with another of your devices, or is ringing you, **Call** opens
that call instead of placing a new one. For a call on another device, the page says which device
has it and offers **End call**, which hangs it up from here. This is also the way to end a call that
a closed tab or a lost phone left open.

Calls use OpenAI's GPT-Live voice model (`gpt-live-1`) with the OpenAI API key saved in
**Settings → Orchestrator**. Without a key, **Call** is disabled on web, desktop, and the phone
app's agent screen, with a note saying a key is needed; the phone button in the phone app's Agents
list is hidden. OpenAI bills call time to that key. A ring that nobody answers costs nothing,
because the voice session only starts when the call connects.

During a call:

- What you say goes into the agent's own chat as an ordinary message, starting with "From our
  voice call". The agent then works with the same tools, rules and approval policy as for a typed
  message.
- If the agent is busy, your message joins the turn it is already working on. With a provider that
  can't take new input mid-turn, Solla Code stops the current turn and starts a new one with your
  message.
- The agent keeps talking with you while its chat works. When the chat replies, the agent tells
  you the result in a few sentences. A long reply is shortened, and the agent tells you the full
  reply is in its chat.
- If the chat asks a question, the agent asks you, and your spoken answer is sent as the answer to
  that question. A question that can't take a spoken answer has to be answered in Solla Code; the
  agent tells you so, and what you said still goes to the chat as a message.
- If the chat needs an approval, the agent tells you. Approvals still happen in Solla Code. Saying
  yes on the call does not approve anything.
- **Chat** opens the agent's chat and shrinks the call to a small pill with the timer. Tap the pill
  to go back to the call.
- **End** hangs up. Closing or reloading the page also hangs up.

The device you call from connects. While the call still rings, you can take it on another device
instead: on web or desktop, **Call** for that agent opens the ringing call, and **Join** connects
it there. The first device to connect takes the call, and the other one shows "Answered on
<device>". Hanging up on a device that hasn't connected only cancels the ring; it never ends a call
another device answered. To end that call from another device, use **End call** on its page. A
device runs one call at a time, and starting a call stops a running orchestrator voice session.
Deleting an agent ends its calls.

A call only lasts while the device holding it is there. If that device disappears without hanging
up (a crashed browser, a phone that lost its connection, an app that was killed), the call ends on
its own about a minute later. If the call drops on your side, the call screen says "The call
dropped." When a call doesn't end normally, the call screen says how it ended: declined, missed, or
failed, with the reason when Solla Code knows it.

In the phone app, the call screen is the web call page shown inside the app, the same way the
orchestrator is. The microphone and audio are on the phone. Closing the call screen hangs up a call
that this phone is on, and cancels a call this phone placed that is still ringing. It never hangs
up a call answered on another device, even one that another device answered while this phone was
still connecting: if another device takes a call this phone placed, the screen says so, and
closing it leaves that call alone. When a call this phone was on ends, including one you hang up
before it connects, the screen shows that it ended and then closes. If the call fails, the screen
stays open with the reason until you close it.

### Transferring a call

Ask the agent you're talking to for another of your agents, for example "Can I talk to Gregg?",
and it answers "Transferring you to Gregg." The screen reads "Transferring to Gregg…" while it says
so. Then the call hangs up quietly, with no hang-up tone and no "Call ended" screen, and the same
device calls Gregg, as if you had tapped **Call** on Gregg. The new call is a call of its own: it
talks in Gregg's chat and starts a new timer. Others you added to the first call don't come along.
Your microphone choice and mute state carry over. If the new call can't be placed, the call screen shows why.

Only agents can take a transferred call, and only the ones the agent was told about when the call
connected: your other agents on that computer that aren't stopped. Ask for anyone else and the
agent says it can't reach them. A name that comes out a little differently in the transcript, such
as "Greg" for "Gregg", still finds the agent when only one fits. The agent has to say the phrase as
its own sentence: "I won't be transferring you to Gregg." or a reply it reads out that mentions a
transfer doesn't move the call.

If you opened the call from its own page (a call notification), that page moves to the new call
too, so minimising the call shows the call you're on, not the one you left.

In the phone app, the call screen follows the call to the new agent instead of closing, and its
title changes to that agent. If the new call can't be placed, the screen stays open with the
reason. Closing the screen during or after a transfer hangs up the new call, or cancels it if it is
still ringing. Close the screen in the moment before the new call reaches the phone and that call
keeps ringing until it times out, about 30 seconds, during which calling that agent again says
you're already on a call.

### Adding others to a call

You can bring up to four others onto a call: your other agents and your recent chats. The agent
you called stays the only voice. The others hear what you say to them and answer through it.

Add someone:

- by voice: "Add Gregg to the call." The agent answers "Adding Gregg to the call." and Gregg
  joins. Ask for several at once ("Add Gregg and Nova") and the agent adds each of them. Someone
  already on the call is left as they are. If the agent names someone who isn't on the list, that
  name isn't added: the call screen says "No one called … is on the call list." and the agent tells
  you and asks who you meant.
- with **Add** on the call screen, which lists who you can add, agents first, then chats. It works
  once the call is connected, and is greyed out with four others already on the call or during a
  transfer.
- with **Add someone to the call...** in the command palette while a call is live on web or
  desktop.

The list is fixed when the call connects. It holds your other agents that aren't stopped, then up
to 12 of your most recently active chats, at most 30 names in all. Archived chats, side chats, the
orchestrator, Agent Builder and delegated workers are never on it, and neither is a chat whose title
reads the same as a name already listed. An agent joins under its name, a chat under its title. An
agent or chat created after the call connected can join the next call. With an older version of
Solla Code on the computer the agent runs on, or on the device holding the call, the agent doesn't
offer transfers or adds.

Everyone else on the call shows under the agent's name, each with a remove button. Take someone off
with that button, by voice (ask the agent to drop Gregg and it answers "Removing Gregg from the
call."), or with **Remove <name> from the call** in the command palette. Removing a chat only takes
it off the call; work it already started goes on in its chat. The minimised pill shows **+N** for
the others on the call, and the page for a call held on another device lists them under "Also on
the call". The phone app's call page has the same **Add** button and list; on iOS 26 and later the
screen's header also shows "with Gregg, Nova" under the agent's name.

If adding or removing someone fails, the reason shows on the call screen, for example "A call can
have at most 4 others on it." or "That chat is archived. Unarchive it to add it to a call." The
agent doesn't say it aloud, but knows it if you ask. If the agent says it is dropping someone who
isn't on the call, the screen says "<name> isn't on this call." and the agent tells you and asks
who you meant.

Where your words go:

- What you say goes to the agent you called, as on any call.
- Name someone on the call and it goes to them instead: "Gregg, what's on my calendar today?" Name
  the agent you called as well and it goes to both. Only what you just said decides this: earlier
  words the agent handled itself, such as "Add Gregg to the call." or "Thanks, everyone.", don't.
- An agent whose name has two or more words can be named by its first word, when that word has four
  or more letters and nobody else on the call shares it ("Nova" for "Nova Bright"). A chat needs its
  whole title ("Quarterly report", not "Quarterly"), because titles often start with everyday
  words.
- Speak to the group and it goes to everyone on the call: "all of you", "you all", "y'all", "both
  of you" or "you guys" anywhere, "you two" as in "Can you two…?", and "everyone", "everybody",
  "guys" or "folks" when you say it to them: "Everyone, …", "Everyone ready?", "…, everybody?",
  "What do you think, everyone?", "Hey guys", "Thanks everyone", "What does everyone think?".
  "Everyone" about other people ("send it to everyone on the team", "Everyone on the team needs
  access.") isn't said to the call. Neither is "are you all set" or "are you all right", and a
  question you open with a name ("Scout, does everyone have access?") goes to that one.
- When a chat on the call asks you a question about what you just said to it, or asks one the agent
  has just read out to you, you can answer without naming it, as long as nobody else on the call is
  also waiting on an answer. This works for questions you can answer by voice, not for approvals. A
  question you talked past (you spoke to someone else after hearing it) needs its name: "Gregg, the
  work account."
- Names are matched as whole words, ignoring case, accents and punctuation. A name said only inside
  a longer name on the call counts as the longer one: "Atlas migration, …" goes to the "Atlas
  migration" chat, not to the agent Atlas. A name of four or more letters that the transcript
  spells a little differently ("Greg" for "Gregg") still counts when you say it to them, as in
  "Greg, …" or "…, Greg?", and nobody else on the call fits it. A chat titled with a common word
  also takes sentences that use that word: a chat called "Deploy" gets "deploy it now". Remove it
  from the call if that gets in the way.

Each chat gets your words as a message from you, starting with "From our voice call" and with a
line saying who else is on the call, so its usual tools, rules and approval policy apply as for a
message you typed there. A chat only gets what was said since the last words went out, and only
when those words are for it: it doesn't hear what you said to the others. If it was waiting on a
question you can answer by voice, your words go in as the answer instead.

Each chat's replies come back with its name, and the agent reads each one out as theirs as soon as
it arrives: "Gregg: …", followed by who is not done yet. A question or an approval from any chat on
the call is passed on right away, with its name, and always ends with what you have to do
(approvals still happen in Solla Code). When several chats answer the same words, each reply is
shortened so all of them fit, and the full replies stay in their chats. A chat that can't answer
reads as "<name> couldn't answer", and the others still do. A chat still working when you say
something else keeps being followed, so its reply still reaches you. If a chat on the call is
deleted, it leaves the call and the agent tells you; the call goes on. An answer arriving just as you speak again is carried into the next stream, even when you address the same chat. You may hear that answer again if the earlier stream had already played it.

The call keeps one voice session, so adding others doesn't start a second one billed to your
OpenAI key. Each chat on the call works with its own provider, as it would for a typed message.

## When an agent calls you

An agent can ring you when:

- it reports a new **Waiting on you** request (a blocker),
- its chat stops to ask you a question or to wait for an approval,
- it asks to talk with you. Agents are told to do this only when a live conversation is really
  needed. Reporting a blocker already rings, so an agent doesn't do both. The agent's side chats
  and delegated workers can ask for it as the agent, and any other chat can message the agent to
  ask it to call you. Either way, the call talks in the agent's own chat.

The incoming call shows the agent's character, "<agent> is calling", the reason, and **Answer**
and **Decline**. A ringtone plays (it follows your sound settings), and the device vibrates where
the browser allows it. Every device connected to that computer rings, as described in
[Where a call rings](#where-a-call-rings). The first device to answer takes the call and the others
stop ringing. A device that answers too late shows "Answered on <device>". When you answer, the
agent speaks first and says why it called.

If nobody answers within 45 seconds, it becomes a missed call. The agent posts a "Missed call from
<agent>" alert with the reason (its notification settings apply), and the blocker, question or
approval card is still in its chat. If the request is dealt with before you answer, for example you
answer the question in the chat, the ringing stops. Declined and missed calls add nothing else to
the agent's chat.

Limits that keep calls from becoming noise:

- One call per agent at a time.
- After ringing for a blocker, question or approval, the same agent waits about 10 minutes before
  ringing again for another one.
- An agent can ask to talk at most 3 times an hour. After that it is told to report a blocker
  instead.
- Requests from before the server started never ring.

**Settings → Orchestrator → Agents can call me** turns incoming calls on or off for the whole
computer. It is on by default, but nothing rings until an OpenAI key is saved. With it off,
blockers, questions and approvals still show up as cards and push notifications, as before.

### Where a call rings

- **Web and desktop app, open:** the ringing screen appears in the app, with the ringtone. If the
  window or tab is in the background, a system notification also appears where notifications are
  allowed and this browser has no push subscription.
- **Home Screen web app, or a browser with push notifications on:** a push notification. It reads
  "<agent> is calling" with the reason when **Show notification details** is on, and "Incoming
  call" without them. Tap it to open the call page, then tap **Answer**. Browsers need that tap
  before they can use the microphone. On iPhone and iPad the notification plays the normal
  notification sound once. A web app can't play a ringtone or open itself. When the call is
  answered elsewhere or stops ringing, the notification is quietly replaced and then usually
  cleared; a missed call leaves a missed-call notification. See
  [Push notifications](./push-notifications.md#agent-calls).
- **Phone app:** rings only while the app is open and in front. It shows the full-screen call
  screen and vibrates in a ring pattern until the call is answered or its 45 seconds are up. It
  can't ring while the app is in the background or the phone is locked, because that needs native
  call support the app doesn't have. To get calls on a locked phone, add Solla Code to the Home
  Screen from Safari and turn on push notifications there. While the orchestrator or another call
  is open in the app, an incoming call waits until it closes, and rings then if it is still
  ringing. The web pages shown inside the app never ring on their own; the app does.

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

### Continuation after a host restart

A recovered native provider turn remains linked to its original user or Agent-continuation message.
When that recovered turn finishes without `AGENT_STOP`, Agent mode schedules the next continuation,
including when additional user messages were delivered into the same turn. A newer request that has
not been delivered, an explicit stop, or a pending user decision still takes precedence. Restart
recovery does not create another visible user message or require reopening the chat.

Scheduled tasks remain saved while their agent is stopped. Their cards show “waiting for agent,” and agent scheduling tools report that execution is blocked instead of promising a run. Starting the agent first asks how to handle overdue work. A scheduled task waits for its target conversation to become free, not for unrelated side chats.

When starting an agent with overdue work, choose **Combine and start**, **Skip backlog and start**, or **Cancel**. Combine sends one catch-up task containing the retained instructions and asks the agent to reconcile them against current progress. Skip consumes the missed occurrences without sending them. Recurring tasks move to their next future run; old one-off tasks remain paused for review. Cancel keeps the agent stopped and does not change the backlog. AI-initiated starts also require this choice rather than releasing overdue tasks automatically.
