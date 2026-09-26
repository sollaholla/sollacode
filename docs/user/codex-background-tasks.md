# Codex background tasks

Codex subagents appear in the same **Background tasks** panel under the composer as Claude tasks. Each row identifies the child, its current work, status, and provider-reported cumulative tokens. A missing token reading says **tokens unknown**. Repeated readings replace the total rather than adding to it.

Child text, reasoning and command streams stay out of the main assistant transcript. Their progress and final summary belong to their background task. The main assistant can still report or discuss a child's results in its own reply.

**Stop** targets that child's observed running turn, without interrupting the parent. Finished tasks can be dismissed, and the existing retention and stale-status rules apply. The panel is shared by desktop and web, including Safari on a phone. The native React Native client currently presents provider task activity in its feed; it does not yet have this composer task panel for either Claude or Codex.
