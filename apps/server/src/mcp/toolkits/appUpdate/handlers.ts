import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as DesktopAppUpdater from "./DesktopAppUpdater.ts";
import * as DesktopAppUpdateConfirmation from "./confirmation.ts";
import { AppUpdateToolkit } from "./tools.ts";
import { AppUpdateCredentialCapabilityError } from "./types.ts";

export const handleAppUpdate = Effect.fn("AppUpdate.handle")(function* (
  input: import("./types.ts").AppUpdateInput,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("app-update")) {
    return yield* new AppUpdateCredentialCapabilityError({});
  }

  const updater = yield* DesktopAppUpdater.DesktopAppUpdater;
  const confirmation = yield* DesktopAppUpdateConfirmation.DesktopAppUpdateConfirmation;
  const inspection = yield* updater.inspect(input.path);
  const forced = input.force === true;
  if (!forced) {
    const outcome = yield* confirmation.confirm(inspection);
    if (outcome !== "confirmed") {
      return {
        status: "cancelled" as const,
        platform: inspection.platform,
        artifactPath: inspection.artifactPath,
        targetPath: inspection.targetPath,
        artifactKind: inspection.artifactKind,
        version: inspection.version,
        reason:
          outcome === "unsupported"
            ? ("confirmation_unsupported" as const)
            : ("user_declined" as const),
      };
    }
  }

  yield* updater.schedule(inspection);
  return {
    status: "scheduled" as const,
    platform: inspection.platform,
    artifactPath: inspection.artifactPath,
    targetPath: inspection.targetPath,
    artifactKind: inspection.artifactKind,
    version: inspection.version,
    logPath: inspection.logPath,
    autoResume: true as const,
    confirmation: forced ? ("forced" as const) : ("confirmed" as const),
  };
});

export const AppUpdateToolkitHandlersLive = AppUpdateToolkit.toLayer({
  app_update: handleAppUpdate,
});
