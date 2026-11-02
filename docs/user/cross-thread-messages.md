# Messages between chats

Any chat can message another chat or a custom agent, and get the reply back. Messages delivered by another chat, an agent, or the orchestrator appear on the AI side of the conversation, with the sender’s name and a muted “Sent by another thread” label. Select the name to open its source conversation, including side chats and agent threads, in the same environment.

## Sending a message

Agents send these messages with the `workspace_consult` tool, which every chat has, including agent CLIs started in a Solla terminal:

- `list_threads` and `list_projects` show what exists. Agent chats are marked, so a chat can find an agent to talk to. `agent_collaboration` `list_agents` lists the agents too.
- `ask` with a thread sends the question into that chat and waits for its reply, a minute by default and at most two. With `waitMs` 0 it just sends. `read_thread` collects a reply that was still being written.
- `ask` with a project opens a new chat there for the question. When an agent asks, the new chat uses that agent’s browser profile; otherwise it uses the project’s. It is marked with who created it (see below).

The sender is the asking chat’s title, or the agent’s name when an agent, one of its side chats, or one of its delegated workers asks.

A question that lands while the other chat is busy joins its running turn, and that turn’s reply counts as the answer. Kimi, Deep Code and Antigravity can’t take a message in the middle of a turn, so on those a question stops the running turn and runs as the next one, the same as a message you type mid-turn.

To have the person called, a chat asks an agent this way to use `call_user`; see [When an agent calls you](./custom-agents.md#when-an-agent-calls-you). The call’s conversation happens in that agent’s chat.

Only the orchestrator can post into another chat as if the person had typed it, or interrupt its turn other than in the case above, with `workspace_orchestration` `send_to_thread` and `interrupt_thread`. Every chat can look across threads and terminals with `workspace_orchestration` `list_threads`, `describe_thread`, `list_terminals`, and `read_terminal`, and can list, read and type into any live terminal pane with `thread_terminals`. See [the orchestrator](./orchestrator.md#what-stays-with-the-orchestrator).

## Limits

Chats asking chats can loop, so the server refuses an `ask` that would:

- reach the asking chat’s own family: the chat itself, its main chat, and every side chat of that main chat (for an agent’s side chats and workers, the agent’s own chat too). Those talk through `thread_collaboration` instead.
- reach the orchestrator, the Agent Builder, or a delegated worker’s chat.
- reach a chat this one is answering for, directly or further up the chain (A asks B while answering a question from B).
- pass one request along more than three times: you ask A, A asks B, B asks C, C asks D, and D has to answer itself. A message from you or the orchestrator starts a new chain.
- reach a stopped agent’s chat. An agent under your control still receives it, since you see it.
- go past 20 asks from one chat in 10 minutes.
- open a new chat when the asking chat already created 10 that aren’t archived, or when it is a delegated worker. A worker can still message existing chats.

## Approvals

In Agent mode, a turn normally approves its own `request_action_approval` calls. A turn that received another chat’s message does not, whether the message started the turn or joined it while it ran: it asks you, the same as delegated work. The turns Agent mode continues with on its own after it ask you too, until you or the orchestrator send the chat a message. Your answer to an approval card is not such a message: the work it lets go on still asks you, even when you or a scheduled task started something else in that chat before you answered. A message between a main chat and its side chats counts as whatever started the sending chat's work when it was sent, yours or another chat's; what that chat does later doesn't change it. Turns started by you or by the orchestrator are otherwise unchanged.

Tasks an agent adds, or whose title, prompt, criteria or schedule it changes, in such a turn are saved as drafts that wait for your approval; see [Scheduling and approval](./custom-agents.md#scheduling-and-approval).

## Chats opened by another chat

A chat opened by another chat shows a small icon in the sidebar on web, desktop, and the phone app. Its tooltip, or the row’s accessibility label on the phone, names the creator: the agent’s name when an agent or one of its side chats or workers opened it, “Created by the Orchestrator” when the orchestrator itself opened it, the creating chat’s title (a side chat of the orchestrator included), or “Created by another chat” when that chat is gone or not loaded. A link icon marks a chat that uses another chat’s browser profile.

## How the message is shown

Sender attribution is recorded by the server from the sending tool’s thread identity. It survives reloads and works independently of the selected provider. The receiving provider still receives the message through its existing input path. Older messages without recorded sender information are not relabelled by guessing from their text.

This presentation is shared by the web/desktop and native mobile clients. Deleted source threads follow the app’s existing missing-thread navigation behavior.

Sender messages use a subtle blue tint. The sender name is a chip, and the attribution stays inside the bubble. Opening a sender collapses any visible side-chat panel on the current or destination thread without closing its tabs or stopping its work.

The timestamp, copy control, and delivery receipt stay inside the sender bubble, below its attribution.
