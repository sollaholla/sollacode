import { McpSchema, Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as DesktopAppUpdater from "./DesktopAppUpdater.ts";
import * as DesktopAppUpdateConfirmation from "./confirmation.ts";
import { AppUpdateError, AppUpdateInput, AppUpdateResult } from "./types.ts";

export const AppUpdateTool = Tool.make("app_update", {
  description:
    "Update the running Solla Code desktop application from an absolute artifact path on its host. The artifact is verified before any prompt or shutdown. By default the user must answer Yes; force:true skips confirmation only when the user already explicitly authorized this exact update. The confirmation is an MCP elicitation, so it is shown by the calling client rather than by Solla Code; a client that does not support elicitation returns status:cancelled reason:confirmation_unsupported, which means the user was never asked -- get their approval another way, then re-run with force:true. A successful call schedules a guarded installer that closes Solla Code, installs the artifact, and relaunches with --auto-resume. Supports macOS .app/.dmg/.zip and Windows NSIS .exe artifacts.",
  parameters: AppUpdateInput,
  success: AppUpdateResult,
  failure: AppUpdateError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    DesktopAppUpdater.DesktopAppUpdater,
    DesktopAppUpdateConfirmation.DesktopAppUpdateConfirmation,
    McpSchema.McpServerClient,
  ],
})
  .annotate(Tool.Title, "Update Solla Code")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const AppUpdateToolkit = Toolkit.make(AppUpdateTool);
