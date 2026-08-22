import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { McpSchema } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as DesktopAppUpdater from "./DesktopAppUpdater.ts";
import * as DesktopAppUpdateConfirmation from "./confirmation.ts";
import { handleAppUpdate } from "./handlers.ts";

const inspection: DesktopAppUpdater.DesktopAppUpdateInspection = {
  platform: "darwin",
  artifactKind: "dmg",
  version: "0.1.96",
  productName: "Solla Code",
  artifactPath: "/tmp/Solla-Code-0.1.96.dmg",
  targetPath: "/Applications/Solla Code.app",
  updaterScriptPath: "/Applications/Solla Code.app/Contents/Resources/app-update/install.sh",
  desktopPid: 111,
  backendPid: 222,
  healthUrl: "http://127.0.0.1:3773/",
  logPath: "/tmp/desktop-app-update.log",
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: { elicitation: {} },
    clientInfo: { name: "app-update-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused by mocked confirmation"),
});

const invocation = (capabilities: ReadonlySet<McpInvocationContext.McpCapability>) =>
  McpInvocationContext.McpInvocationContext.of({
    environmentId: EnvironmentId.make("environment-app-update"),
    threadId: ThreadId.make("thread-app-update"),
    providerSessionId: "provider-session-app-update",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities,
    issuedAt: 1,
  });

const run = (
  input: { readonly path: string; readonly force?: boolean },
  options: {
    readonly confirmed?: boolean;
    readonly outcome?: DesktopAppUpdateConfirmation.DesktopAppUpdateConfirmationOutcome;
    readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  } = {},
) => {
  const inspect = vi.fn(() => Effect.succeed(inspection));
  const schedule = vi.fn(() => Effect.void);
  const confirm = vi.fn(() =>
    Effect.succeed(
      options.outcome ??
        ((options.confirmed ?? true) ? ("confirmed" as const) : ("declined" as const)),
    ),
  );
  const effect = handleAppUpdate(input).pipe(
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      invocation(options.capabilities ?? new Set(["app-update"])),
    ),
    Effect.provideService(
      DesktopAppUpdater.DesktopAppUpdater,
      DesktopAppUpdater.DesktopAppUpdater.of({ inspect, schedule }),
    ),
    Effect.provideService(
      DesktopAppUpdateConfirmation.DesktopAppUpdateConfirmation,
      DesktopAppUpdateConfirmation.DesktopAppUpdateConfirmation.of({ confirm }),
    ),
    Effect.provideService(McpSchema.McpServerClient, client),
  );
  return { effect, inspect, schedule, confirm };
};

it.effect("verifies, confirms, and schedules an app update", () => {
  const harness = run({ path: inspection.artifactPath });
  return Effect.gen(function* () {
    expect(yield* harness.effect).toEqual({
      status: "scheduled",
      platform: "darwin",
      artifactPath: inspection.artifactPath,
      targetPath: inspection.targetPath,
      artifactKind: "dmg",
      version: "0.1.96",
      logPath: inspection.logPath,
      autoResume: true,
      confirmation: "confirmed",
    });
    expect(harness.inspect).toHaveBeenCalledWith(inspection.artifactPath);
    expect(harness.confirm).toHaveBeenCalledWith(inspection);
    expect(harness.schedule).toHaveBeenCalledWith(inspection);
  });
});

it.effect("returns a cancellation without starting the installer when the user says no", () => {
  const harness = run({ path: inspection.artifactPath }, { confirmed: false });
  return Effect.gen(function* () {
    expect(yield* harness.effect).toMatchObject({
      status: "cancelled",
      reason: "user_declined",
      version: "0.1.96",
    });
    expect(harness.schedule).not.toHaveBeenCalled();
  });
});

it.effect("reports a client that cannot be asked instead of hanging on it", () => {
  // The elicitation goes to the calling MCP client, not to a window the user
  // can see. A client without the capability never answers, so the call used to
  // sit until it timed out with nothing shown anywhere.
  const harness = run({ path: inspection.artifactPath }, { outcome: "unsupported" });
  return Effect.gen(function* () {
    expect(yield* harness.effect).toMatchObject({
      status: "cancelled",
      reason: "confirmation_unsupported",
      version: "0.1.96",
    });
    expect(harness.schedule).not.toHaveBeenCalled();
  });
});

it.effect("force true bypasses confirmation but still verifies the artifact", () => {
  const harness = run({ path: inspection.artifactPath, force: true }, { confirmed: false });
  return Effect.gen(function* () {
    expect(yield* harness.effect).toMatchObject({
      status: "scheduled",
      confirmation: "forced",
    });
    expect(harness.inspect).toHaveBeenCalledOnce();
    expect(harness.confirm).not.toHaveBeenCalled();
    expect(harness.schedule).toHaveBeenCalledOnce();
  });
});

it.effect("rejects credentials without app-update capability before inspecting disk", () => {
  const harness = run(
    { path: inspection.artifactPath, force: true },
    { capabilities: new Set(["history"]) },
  );
  return Effect.gen(function* () {
    const error = yield* Effect.flip(harness.effect);
    expect(error._tag).toBe("AppUpdateCredentialCapabilityError");
    expect(harness.inspect).not.toHaveBeenCalled();
    expect(harness.schedule).not.toHaveBeenCalled();
  });
});
