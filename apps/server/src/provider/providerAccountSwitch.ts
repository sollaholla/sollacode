import * as NodeCrypto from "node:crypto";

import {
  ProviderAccountSwitchError,
  type ProviderAccountSwitchState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import type { ProviderAccountAuthCapability, ProviderAccountAuthStatus } from "./ProviderDriver.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

const OUTPUT_LIMIT_BYTES = 32_000;
const STATUS_RETRY_COUNT = 20;
const STATUS_RETRY_DELAY_MS = 750;

const activeStatuses = new Set<ProviderAccountSwitchState["status"]>([
  "logging_out",
  "starting_login",
  "waiting_for_authentication",
  "waiting_for_code",
  "refreshing_account",
]);

class ProviderAccountSwitchFlowError extends Data.TaggedError("ProviderAccountSwitchFlowError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface AccountSwitchFlow {
  state: ProviderAccountSwitchState;
  interrupt: Effect.Effect<void> | null;
  submitAuthCode: ((code: string) => Effect.Effect<void, ProviderAccountSwitchFlowError>) | null;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ProviderAccountSwitchShape {
  readonly start: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAccountSwitchState, ProviderAccountSwitchError>;
  readonly get: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly switchId?: string;
  }) => Effect.Effect<ProviderAccountSwitchState | null>;
  readonly submitCode: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly switchId: string;
    readonly code: string;
  }) => Effect.Effect<ProviderAccountSwitchState, ProviderAccountSwitchError>;
  readonly cancel: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly switchId: string;
  }) => Effect.Effect<ProviderAccountSwitchState, ProviderAccountSwitchError>;
}

export class ProviderAccountSwitch extends Context.Service<
  ProviderAccountSwitch,
  ProviderAccountSwitchShape
>()("t3/provider/providerAccountSwitch") {}

function nowIso(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}

function accountLabel(snapshot: {
  readonly auth: {
    readonly email?: string | undefined;
    readonly label?: string | undefined;
    readonly type?: string | undefined;
  };
}): string | null {
  return (
    snapshot.auth.email?.trim() || snapshot.auth.label?.trim() || snapshot.auth.type?.trim() || null
  );
}

function publicFlowFailureMessage(cause: Cause.Cause<unknown>): string {
  const failure = cause.reasons.find(Cause.isFailReason)?.error;
  if (failure instanceof ProviderAccountSwitchFlowError) {
    return failure.message;
  }
  return "The provider login process ended unexpectedly. You can try switching users again.";
}

function extractAuthUrl(output: string): string | null {
  const matches = output.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  const cleaned = matches.map((value) => value.replace(/[),.;]+$/, ""));
  return (
    cleaned.find((value) => /(?:auth|login|oauth|openai|anthropic|claude)/i.test(value)) ??
    cleaned[0] ??
    null
  );
}

function hasManualAuthCodePrompt(output: string): boolean {
  const normalized = output
    .split(String.fromCharCode(27))
    .map((segment, index) => (index === 0 ? segment : segment.replace(/^\[[0-?]*[ -/]*[@-~]/, "")))
    .join(" ")
    .replace(/\s+/g, " ");
  return (
    /\b(?:paste|enter|input|provide)\b.{0,120}\b(?:authentication|authorization|verification|oauth)?\s*code\b/i.test(
      normalized,
    ) ||
    /\b(?:authentication|authorization|verification|oauth)\s*code\b.{0,120}\b(?:paste|enter|input|provide)\b/i.test(
      normalized,
    )
  );
}

function writeAuthCodeToStdin(
  code: string,
  stdin: ChildProcessSpawner.ChildProcessHandle["stdin"],
) {
  return Stream.run(Stream.encodeText(Stream.make(`${code}\n`)), stdin);
}

export const make = Effect.fn("ProviderAccountSwitch.make")(function* () {
  const instanceRegistry = Option.getOrUndefined(
    yield* Effect.serviceOption(ProviderInstanceRegistry),
  );
  const providerRegistry = yield* ProviderRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const flows = new Map<ProviderInstanceId, AccountSwitchFlow>();

  const updateState = (
    instanceId: ProviderInstanceId,
    switchId: string,
    patch: Partial<Omit<ProviderAccountSwitchState, "id" | "instanceId" | "driver" | "startedAt">>,
  ) =>
    Effect.sync(() => {
      const flow = flows.get(instanceId);
      if (!flow || flow.state.id !== switchId) return null;
      flow.state = {
        ...flow.state,
        ...patch,
        updatedAt: nowIso(),
      };
      return flow.state;
    });

  const spawnCommand = Effect.fn("ProviderAccountSwitch.spawnCommand")(function* (input: {
    readonly capability: ProviderAccountAuthCapability;
    readonly args: ReadonlyArray<string>;
  }) {
    const resolved = yield* resolveSpawnCommand(input.capability.binaryPath, input.args, {
      env: input.capability.environment,
      extendEnv: true,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAccountSwitchFlowError({
            message: `Could not launch ${input.capability.binaryPath}.`,
            cause,
          }),
      ),
    );
    return yield* spawner
      .spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          env: input.capability.environment,
          extendEnv: true,
          shell: resolved.shell,
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAccountSwitchFlowError({
              message: `Could not launch ${input.capability.binaryPath}.`,
              cause,
            }),
        ),
      );
  });

  const runCollectedCommand = Effect.fn("ProviderAccountSwitch.runCollectedCommand")(
    function* (input: {
      readonly capability: ProviderAccountAuthCapability;
      readonly args: ReadonlyArray<string>;
    }) {
      return yield* Effect.gen(function* () {
        const child = yield* spawnCommand(input);
        yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: OUTPUT_LIMIT_BYTES }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: OUTPUT_LIMIT_BYTES }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAccountSwitchFlowError({
                message: "The provider authentication command could not be read.",
                cause,
              }),
          ),
        );
        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: Number(exitCode),
        } satisfies CommandResult;
      }).pipe(Effect.scoped);
    },
  );

  const readAuthenticatedStatus = Effect.fn("ProviderAccountSwitch.readAuthenticatedStatus")(
    function* (capability: ProviderAccountAuthCapability) {
      let lastStatus: ProviderAccountAuthStatus = {
        loggedIn: false,
        accountLabel: null,
      };
      for (let attempt = 0; attempt < STATUS_RETRY_COUNT; attempt += 1) {
        const result = yield* runCollectedCommand({
          capability,
          args: capability.statusArgs,
        });
        lastStatus = capability.parseStatus(result.stdout, result.stderr);
        if (lastStatus.loggedIn) return lastStatus;
        if (attempt + 1 < STATUS_RETRY_COUNT) {
          yield* Effect.sleep(STATUS_RETRY_DELAY_MS);
        }
      }
      return lastStatus;
    },
  );

  const runLoginCommand = Effect.fn("ProviderAccountSwitch.runLoginCommand")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly switchId: string;
    readonly capability: ProviderAccountAuthCapability;
  }) {
    return yield* Effect.gen(function* () {
      const child = yield* spawnCommand({
        capability: input.capability,
        args: input.capability.loginArgs,
      });
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));

      let combinedOutput = "";
      let publishedUrl: string | null = null;
      let publishedCodePrompt = false;

      yield* Effect.sync(() => {
        const flow = flows.get(input.instanceId);
        if (!flow || flow.state.id !== input.switchId) return;
        flow.submitAuthCode = (code) =>
          writeAuthCodeToStdin(code.trim(), child.stdin).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAccountSwitchFlowError({
                  message: "The authentication code could not be sent to Claude Code.",
                  cause,
                }),
            ),
          );
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          const flow = flows.get(input.instanceId);
          if (flow?.state.id === input.switchId) flow.submitAuthCode = null;
        }),
      );

      const captureOutput = (chunk: Uint8Array) =>
        Effect.gen(function* () {
          combinedOutput = `${combinedOutput}${new TextDecoder().decode(chunk)}`.slice(
            -OUTPUT_LIMIT_BYTES,
          );
          const authUrl = extractAuthUrl(combinedOutput);
          const requestsManualCode =
            input.capability.acceptsManualAuthCode === true &&
            hasManualAuthCodePrompt(combinedOutput);
          const discoveredUrl = authUrl !== null && authUrl !== publishedUrl;
          const discoveredCodePrompt = requestsManualCode && !publishedCodePrompt;
          if (!discoveredUrl && !discoveredCodePrompt) return;

          if (discoveredUrl) publishedUrl = authUrl;
          if (discoveredCodePrompt) publishedCodePrompt = true;
          yield* updateState(input.instanceId, input.switchId, {
            ...(discoveredUrl ? { authUrl } : {}),
            ...(discoveredCodePrompt
              ? {
                  status: "waiting_for_code" as const,
                  message: "Paste the authentication code shown in your browser.",
                }
              : {}),
          });
        });

      yield* updateState(input.instanceId, input.switchId, {
        status: "waiting_for_authentication",
        message: "Continue sign-in in your browser.",
      });

      const [exitCode] = yield* Effect.all(
        [
          child.exitCode,
          Stream.runForEach(child.stdout, captureOutput),
          Stream.runForEach(child.stderr, captureOutput),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAccountSwitchFlowError({
              message: "The provider login process ended unexpectedly.",
              cause,
            }),
        ),
      );
      if (Number(exitCode) !== 0) {
        return yield* new ProviderAccountSwitchFlowError({
          message: "Login was not completed. Try again or cancel the account switch.",
        });
      }
    }).pipe(Effect.scoped);
  });

  const runFlow = Effect.fn("ProviderAccountSwitch.runFlow")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly switchId: string;
    readonly capability: ProviderAccountAuthCapability;
    readonly wasAuthenticated: boolean;
  }) {
    if (input.wasAuthenticated) {
      const logout = yield* runCollectedCommand({
        capability: input.capability,
        args: input.capability.logoutArgs,
      });
      if (logout.exitCode !== 0) {
        return yield* new ProviderAccountSwitchFlowError({
          message: "Could not sign out of the current provider account.",
        });
      }
    }

    yield* updateState(input.instanceId, input.switchId, {
      status: "starting_login",
      message: "Starting provider login…",
    });
    yield* runLoginCommand(input);
    yield* updateState(input.instanceId, input.switchId, {
      status: "refreshing_account",
      message: "Verifying the new account…",
    });

    const status = yield* readAuthenticatedStatus(input.capability);
    if (!status.loggedIn) {
      return yield* new ProviderAccountSwitchFlowError({
        message: "Login finished, but the provider did not report an authenticated account.",
      });
    }

    const providers = yield* providerRegistry.refreshInstance(input.instanceId);
    const refreshed = providers.find((provider) => provider.instanceId === input.instanceId);
    const currentAccountLabel = refreshed ? accountLabel(refreshed) : status.accountLabel;
    yield* updateState(input.instanceId, input.switchId, {
      status: "succeeded",
      currentAccountLabel,
      message: currentAccountLabel
        ? `Signed in as ${currentAccountLabel}.`
        : "Signed in successfully.",
    });
  });

  const start: ProviderAccountSwitchShape["start"] = Effect.fn("ProviderAccountSwitch.start")(
    function* (instanceId) {
      if (!instanceRegistry) {
        return yield* new ProviderAccountSwitchError({
          instanceId,
          reason: "Provider account switching is unavailable in this environment.",
        });
      }
      const instance = yield* instanceRegistry.getInstance(instanceId);
      if (!instance) {
        return yield* new ProviderAccountSwitchError({
          instanceId,
          reason: "This provider instance is no longer available.",
        });
      }
      if (!instance.accountAuth) {
        return yield* new ProviderAccountSwitchError({
          instanceId,
          reason: "This provider does not support in-app account switching.",
        });
      }
      const snapshot = yield* instance.snapshot.getSnapshot;
      const previousAccountLabel = accountLabel(snapshot);
      const existing = flows.get(instanceId);
      if (existing && activeStatuses.has(existing.state.status)) {
        return existing.state;
      }

      const startedAt = nowIso();
      const switchId = NodeCrypto.randomUUID();
      const state: ProviderAccountSwitchState = {
        id: switchId,
        instanceId,
        driver: instance.driverKind,
        status: snapshot.auth.status === "authenticated" ? "logging_out" : "starting_login",
        startedAt,
        updatedAt: startedAt,
        authUrl: null,
        previousAccountLabel,
        currentAccountLabel: null,
        message:
          snapshot.auth.status === "authenticated"
            ? "Signing out of the current account…"
            : "Starting provider login…",
      };
      const flow: AccountSwitchFlow = { state, interrupt: null, submitAuthCode: null };
      flows.set(instanceId, flow);

      const fiber = yield* runFlow({
        instanceId,
        switchId,
        capability: instance.accountAuth,
        wasAuthenticated: snapshot.auth.status === "authenticated",
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const current = flows.get(instanceId);
            if (!current || current.state.id !== switchId || current.state.status === "cancelled") {
              return;
            }
            current.state = {
              ...current.state,
              status: "failed",
              updatedAt: nowIso(),
              message: publicFlowFailureMessage(cause),
            };
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            const current = flows.get(instanceId);
            if (current?.state.id === switchId) current.interrupt = null;
          }),
        ),
        Effect.forkDetach({ startImmediately: true }),
      );
      flow.interrupt = Fiber.interrupt(fiber).pipe(Effect.asVoid);
      return state;
    },
  );

  const get: ProviderAccountSwitchShape["get"] = (input) =>
    Effect.sync(() => {
      const flow = flows.get(input.instanceId);
      if (!flow) return null;
      if (input.switchId === undefined) {
        return activeStatuses.has(flow.state.status) ? flow.state : null;
      }
      return flow.state.id === input.switchId ? flow.state : null;
    });

  const submitCode: ProviderAccountSwitchShape["submitCode"] = Effect.fn(
    "ProviderAccountSwitch.submitCode",
  )(function* (input) {
    const flow = flows.get(input.instanceId);
    if (!flow || flow.state.id !== input.switchId) {
      return yield* new ProviderAccountSwitchError({
        instanceId: input.instanceId,
        reason: "The account switch is no longer active.",
      });
    }
    const code = input.code.trim();
    if (code.length === 0) {
      return yield* new ProviderAccountSwitchError({
        instanceId: input.instanceId,
        reason: "Paste the authentication code from the browser.",
      });
    }
    if (/[\r\n]/.test(code)) {
      return yield* new ProviderAccountSwitchError({
        instanceId: input.instanceId,
        reason: "The authentication code must be a single line.",
      });
    }
    if (flow.state.status !== "waiting_for_code" || !flow.submitAuthCode) {
      return yield* new ProviderAccountSwitchError({
        instanceId: input.instanceId,
        reason: "Claude Code is not waiting for an authentication code.",
      });
    }

    yield* updateState(input.instanceId, input.switchId, {
      status: "waiting_for_authentication",
      message: "Authentication code sent. Waiting for Claude Code…",
    });
    yield* flow.submitAuthCode(code).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* updateState(input.instanceId, input.switchId, {
            status: "waiting_for_code",
            message: "Could not send the code. Paste it again to retry.",
          });
          return yield* new ProviderAccountSwitchError({
            instanceId: input.instanceId,
            reason: cause.message,
            cause,
          });
        }),
      ),
    );
    return flow.state;
  });

  const cancel: ProviderAccountSwitchShape["cancel"] = Effect.fn("ProviderAccountSwitch.cancel")(
    function* (input) {
      const flow = flows.get(input.instanceId);
      if (!flow || flow.state.id !== input.switchId) {
        return yield* new ProviderAccountSwitchError({
          instanceId: input.instanceId,
          reason: "The account switch is no longer active.",
        });
      }
      if (!activeStatuses.has(flow.state.status)) return flow.state;
      flow.state = {
        ...flow.state,
        status: "cancelled",
        updatedAt: nowIso(),
        message: "Account switching was cancelled.",
      };
      if (flow.interrupt) yield* flow.interrupt;
      return flow.state;
    },
  );

  return ProviderAccountSwitch.of({ start, get, submitCode, cancel });
});

export const layer = Layer.effect(ProviderAccountSwitch, make());

export const providerAccountSwitchInternals = {
  extractAuthUrl,
  hasManualAuthCodePrompt,
  writeAuthCodeToStdin,
};
