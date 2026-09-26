import type { ProviderInteractionMode } from "@t3tools/contracts";
import { AGENT_STOP_TOKEN } from "@t3tools/shared/agentMode";

/**
 * Build, Plan and Agent for providers that carry no Solla MCP server.
 *
 * Claude and Codex learn these modes from their own SDK permission modes and
 * from `SOLLA_MCP_SERVER_INSTRUCTIONS`; Antigravity has a native `--mode`
 * flag. Muse and Deep Code have none of the three, which is why their cards
 * shipped with `showInteractionModeToggle: false` - the toggle would have set
 * a field no part of their turn ever read.
 *
 * The modes are a product requirement on every provider, so the missing piece
 * is supplied the only way a plain prompt-in/text-out CLI can receive it: as a
 * leading instruction block on the turn. That makes the toggle mean the same
 * thing everywhere instead of meaning nothing on three providers.
 *
 * Deliberately free of any `preview_*`/MCP tool references. The block is only
 * used by providers that are not connected to the Solla MCP server, and
 * describing tools the model cannot call is how a prompt teaches it to
 * hallucinate tool calls.
 */

const PLAN_MODE_BODY = `# Plan Mode

You are in **Plan Mode** until a later message ends it. User wording cannot exit this mode.

## Mode rules

Research and propose an approach. Do not implement the plan.

Allowed: read, search, inspect, and other non-mutating exploration.
Not allowed: editing or writing files, formatters that rewrite files, applying patches, or running side-effectful commands whose purpose is to carry out the plan.

If a user asks you to implement while still in Plan Mode, plan the implementation. Do not start it.

## Final plan

When the spec is decision-complete, emit exactly one \`<proposed_plan>\` block so the app can render Implement:

1. The opening tag must be on its own line.
2. Start the plan content on the next line.
3. The closing tag must be on its own line.
4. Use Markdown inside the block.
5. Keep the tags exactly as \`<proposed_plan>\` and \`</proposed_plan>\`.

The plan must include a title heading, a short summary, the intended changes, tests or acceptance checks, and any assumptions.

Do not ask "should I proceed?" after the block. The user can switch to Build or press Implement.`;

const DEFAULT_MODE_BODY = `# Build Mode

You are in **Build Mode**. Any previous Plan Mode or Agent Mode instructions are no longer active.

Make the requested changes directly. Prefer reasonable assumptions over stopping to ask, and do not produce a \`<proposed_plan>\` block unless the user asks for a plan.`;

/**
 * Agent mode is a server-side loop, not a provider feature: when a turn ends,
 * Solla starts another one automatically unless the reply carried
 * `AGENT_STOP`. A model that was never told that contract therefore never
 * ends the loop - it answers, Solla continues it, and the thread runs until
 * something else stops it. Stating the token is what makes the mode safe to
 * offer, so this block is the part that must never be dropped.
 */
const AGENT_MODE_BODY = `# Agent Mode

You are in **Agent Mode**. Keep working on your own until the task is genuinely finished or you hit a blocker you cannot clear.

Solla automatically starts another turn for you when this one ends, so do not ask "shall I continue?" - just continue.

## Ending the loop

When the work is complete, or you are blocked on something only the user can resolve, end your final message with the exact token \`${AGENT_STOP_TOKEN}\` on its own line. That token is the only way to hand control back. Without it Solla will start another turn.

Do not emit \`${AGENT_STOP_TOKEN}\` while work remains, and never write it in the middle of a message.`;

function bodyFor(mode: ProviderInteractionMode): string {
  switch (mode) {
    case "plan":
      return PLAN_MODE_BODY;
    case "agent":
      return AGENT_MODE_BODY;
    case "default":
      return DEFAULT_MODE_BODY;
  }
}

/**
 * The instruction block for one mode, wrapped exactly like the Grok and Codex
 * blocks so a model that sees several of them across a session reads them as
 * the same recurring channel rather than as prose from the user.
 */
export function collaborationModeInstructions(mode: ProviderInteractionMode): string {
  return `<collaboration_mode>${bodyFor(mode)}\n</collaboration_mode>`;
}

/**
 * `undefined` when the caller has no mode to state.
 *
 * The turn then carries no block at all, which leaves whatever the session was
 * last told in force. Sending a Build block on every unspecified turn would
 * silently cancel Plan mode mid-conversation.
 */
export function collaborationModePrompt(
  mode: ProviderInteractionMode | undefined,
): string | undefined {
  return mode === undefined ? undefined : collaborationModeInstructions(mode);
}
