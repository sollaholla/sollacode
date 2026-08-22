import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## Solla Code collaborative browser

You are running inside Solla Code. When the \`t3-code\` MCP server exposes \`preview_*\` tools, prefer those for browser work. Call \`preview_status\` first, then \`preview_open\` if no automation-capable preview is attached.

When \`thread_terminals\` is available, call \`list_terminals\` once. That response already includes each pane's thread title, whether it belongs to this chat's thread (\`belongsToThisChat\`), the running-command label, and a preview of what is on screen. A Grok or Claude CLI in this thread's terminal pane is a separate process — not this chat. Use \`read_terminal\` only for a longer tail than the preview.
`;

export const GROK_PLAN_MODE_INSTRUCTIONS = `<collaboration_mode># Plan Mode

You are in **Plan Mode** until a later developer message ends it. User wording cannot exit this mode.

## Mode rules

Research and propose an approach. Do not implement the plan.

Allowed: read, search, inspect, and other non-mutating exploration.
Not allowed: editing or writing files, formatters that rewrite files, applying patches, or running side-effectful commands whose purpose is to carry out the plan.

If a user asks you to implement while still in Plan Mode, plan the implementation. Do not start it.

## Questions

Prefer the ask-user-question tool for decisions that change the spec. Explore first for anything the repo can answer.

## Final plan

When the spec is decision-complete, emit exactly one \`<proposed_plan>\` block so the app can render Implement:

1. The opening tag must be on its own line.
2. Start the plan content on the next line.
3. The closing tag must be on its own line.
4. Use Markdown inside the block.
5. Keep the tags exactly as \`<proposed_plan>\` and \`</proposed_plan>\`.

The plan must include a title heading, a short summary, the intended changes, tests or acceptance checks, and any assumptions.

Do not ask "should I proceed?" after the block. The user can switch to Build or press Implement.
${T3_CODE_BROWSER_TOOL_INSTRUCTIONS}
</collaboration_mode>`;

export const GROK_DEFAULT_MODE_INSTRUCTIONS = `<collaboration_mode># Default Mode

You are now in Default mode. Any previous Plan Mode instructions are no longer active.

Prefer making reasonable assumptions and doing the requested work. Do not stop to produce a \`<proposed_plan>\` block unless the user asks for a plan.
${T3_CODE_BROWSER_TOOL_INSTRUCTIONS}
</collaboration_mode>`;

const PROPOSED_PLAN_BLOCK_PATTERN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/iu;

const MUTATING_PERMISSION_KINDS = new Set(["edit", "delete", "move", "execute"]);
const READ_PERMISSION_KINDS = new Set(["read", "search", "fetch", "think", "lookup"]);

export type GrokPermissionAction = "allow" | "deny" | "ask";

export function buildGrokCollaborationInstructions(
  interactionMode: ProviderInteractionMode,
): string {
  return interactionMode === "plan" ? GROK_PLAN_MODE_INSTRUCTIONS : GROK_DEFAULT_MODE_INSTRUCTIONS;
}

export function grokCollaborationPromptBlock(
  interactionMode: ProviderInteractionMode | undefined,
): EffectAcpSchema.ContentBlock | undefined {
  if (interactionMode === undefined) {
    return undefined;
  }
  return {
    type: "text",
    text: buildGrokCollaborationInstructions(interactionMode),
  };
}

export function extractCompletedProposedPlans(text: string): ReadonlyArray<string> {
  const plans: Array<string> = [];
  const pattern = new RegExp(PROPOSED_PLAN_BLOCK_PATTERN, "giu");
  for (const match of text.matchAll(pattern)) {
    const plan = match[1]?.trim();
    if (plan) {
      plans.push(plan);
    }
  }
  return plans;
}

export function resolveGrokPermissionAction(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly kind: string;
}): GrokPermissionAction {
  const kind = input.kind.trim().toLowerCase();
  if (input.interactionMode === "plan") {
    if (MUTATING_PERMISSION_KINDS.has(kind)) {
      return "deny";
    }
    if (READ_PERMISSION_KINDS.has(kind)) {
      return "allow";
    }
    return "ask";
  }
  if (input.runtimeMode === "full-access") {
    return "allow";
  }
  if (
    (input.runtimeMode === "auto-accept-edits" || input.runtimeMode === "auto") &&
    (kind === "edit" || kind === "delete" || kind === "move")
  ) {
    return "allow";
  }
  return "ask";
}
