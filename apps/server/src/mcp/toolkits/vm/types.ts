import { ThreadId, VmPointerButton } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * One flat multi-action input for the `vm_computer` tool. It is a flat struct
 * (not a discriminated union at the schema root) because a raw `Schema.Union`
 * root breaks the whole MCP `tools/list`; the handler validates the per-action
 * required fields.
 */
export const VmComputerInput = Schema.Struct({
  action: Schema.Literals([
    "screenshot",
    "move",
    "click",
    "double_click",
    "type",
    "key",
    "scroll",
    "wait",
  ]).annotate({
    description:
      "What to do on the agent's computer. `screenshot` returns the current screen as an image; `move`/`click`/`double_click`/`scroll` act at (x, y); `type` types `text`; `key` presses the `keys` chord; `wait` pauses `ms`. Every action returns a fresh screenshot so you can observe the result.",
  }),
  x: Schema.optional(Schema.Number).annotate({
    description:
      "Horizontal position as a fraction of the screen width: 0 = far left, 1 = far right. Required for move/click/double_click/scroll.",
  }),
  y: Schema.optional(Schema.Number).annotate({
    description:
      "Vertical position as a fraction of the screen height: 0 = top, 1 = bottom. Required for move/click/double_click/scroll.",
  }),
  button: Schema.optional(VmPointerButton).annotate({
    description: "Mouse button for click/double_click. Defaults to left.",
  }),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(10_000))).annotate({
    description: "Text to type. Required for action=type.",
  }),
  keys: Schema.optional(Schema.String.check(Schema.isMaxLength(200))).annotate({
    description:
      'Key chord to press, e.g. "Enter", "Tab", "Backspace", "Control+a", "Meta+c". Required for action=key.',
  }),
  deltaX: Schema.optional(Schema.Number).annotate({
    description: "Horizontal scroll amount in pixels (scroll). Defaults to 0.",
  }),
  deltaY: Schema.optional(Schema.Number).annotate({
    description: "Vertical scroll amount in pixels; positive scrolls down (scroll). Defaults to 0.",
  }),
  ms: Schema.optional(Schema.Number).annotate({
    description: "Milliseconds to wait for action=wait. Clamped to a few seconds server-side.",
  }),
});
export type VmComputerInput = typeof VmComputerInput.Type;

export const VmComputerScreenshot = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  /** Base64-encoded PNG bytes; the MCP layer turns this into an image block. */
  data: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
});
export type VmComputerScreenshot = typeof VmComputerScreenshot.Type;

export const VmComputerResult = Schema.Struct({
  action: Schema.String,
  /** Short human-readable summary of what happened. */
  status: Schema.String,
  /** The pointer position after the action, in frame pixels, when known. */
  cursor: Schema.optional(Schema.Struct({ x: Schema.Int, y: Schema.Int })),
  screenshot: VmComputerScreenshot,
});
export type VmComputerResult = typeof VmComputerResult.Type;

// ── Errors ──────────────────────────────────────────────────────────

export class VmComputerCapabilityUnavailableError extends Schema.TaggedErrorClass<VmComputerCapabilityUnavailableError>()(
  "VmComputerCapabilityUnavailableError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "The vm_computer tool is not available to this chat.";
  }
}

export class VmComputerNoAgentError extends Schema.TaggedErrorClass<VmComputerNoAgentError>()(
  "VmComputerNoAgentError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "This chat is not a VM agent, so there is no computer to operate.";
  }
}

export class VmComputerUserControlActiveError extends Schema.TaggedErrorClass<VmComputerUserControlActiveError>()(
  "VmComputerUserControlActiveError",
  { vmAgentId: Schema.String },
) {
  override get message(): string {
    return "The user has taken control of this computer; wait for them to release it before acting.";
  }
}

export class VmComputerInvalidInputError extends Schema.TaggedErrorClass<VmComputerInvalidInputError>()(
  "VmComputerInvalidInputError",
  { action: Schema.String, missing: Schema.String },
) {
  override get message(): string {
    return `vm_computer action "${this.action}" requires "${this.missing}".`;
  }
}

export class VmComputerFailedError extends Schema.TaggedErrorClass<VmComputerFailedError>()(
  "VmComputerFailedError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `vm_computer failed while ${this.operation}: ${this.detail}`;
  }
}

export const VmComputerError = Schema.Union([
  VmComputerCapabilityUnavailableError,
  VmComputerNoAgentError,
  VmComputerUserControlActiveError,
  VmComputerInvalidInputError,
  VmComputerFailedError,
]);
export type VmComputerError = typeof VmComputerError.Type;
