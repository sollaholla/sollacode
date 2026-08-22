import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { VmManager } from "../../../vm/VmManager.ts";
import { VmComputerError, VmComputerInput, VmComputerResult } from "./types.ts";

export const VmComputerTool = Tool.make("vm_computer", {
  description:
    "Operate your own computer — a live web browser desktop that only you control. Use `screenshot` to see the screen, then `move`/`click`/`double_click` at a position, `type` text, press a `key` chord, or `scroll`. Positions are fractions of the screen: x=0 is the left edge, x=1 the right; y=0 the top, y=1 the bottom. Every call returns a fresh screenshot, so take one first to see where to act and read the result of your last action. Your logins persist across restarts. If a call reports the user has taken control, stop and wait — your screen and input are suspended until they hand it back.",
  parameters: VmComputerInput,
  success: VmComputerResult,
  failure: VmComputerError,
  dependencies: [McpInvocationContext.McpInvocationContext, VmManager, VmAgentStore],
})
  .annotate(Tool.Title, "Operate this agent's computer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const VmComputerToolkit = Toolkit.make(VmComputerTool);
