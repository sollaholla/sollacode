import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { afterEach, beforeEach, vi } from "vite-plus/test";

/**
 * The activity report is the only thing that gives the server a demand lease,
 * and every scoped background job — including the provider health probe that
 * feeds the Claude usage bar — is gated on one. Until this file existed the
 * send path had no coverage at all: the module's tests only exercised its pure
 * helpers, so a report that silently stopped reaching the server looked exactly
 * like a report that was never attempted.
 */
const requestCalls: Array<{ readonly method: string; readonly input: unknown }> = [];

vi.mock("@t3tools/client-runtime/rpc", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    request: (method: string, input: unknown) =>
      Effect.sync(() => {
        requestCalls.push({ method, input });
      }),
  };
});

const { EnvironmentRegistry } = await import("@t3tools/client-runtime/connection");
const { backgroundActivityReporterLayer } = await import("./backgroundActivityReporter.ts");

const ENVIRONMENT_ID = EnvironmentId.make("environment-reporter-test");

interface DomStub {
  readonly listeners: Map<string, Set<() => void>>;
}

function installDomStubs(): DomStub {
  const listeners = new Map<string, Set<() => void>>();
  const addEventListener = (type: string, handler: () => void) => {
    const existing = listeners.get(type) ?? new Set<() => void>();
    existing.add(handler);
    listeners.set(type, existing);
  };
  const removeEventListener = (type: string, handler: () => void) => {
    listeners.get(type)?.delete(handler);
  };
  const storage = new Map<string, string>();

  Object.assign(globalThis, {
    window: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      addEventListener,
      removeEventListener,
    },
    document: {
      visibilityState: "visible",
      hasFocus: () => true,
      addEventListener,
      removeEventListener,
    },
  });

  return { listeners };
}

function removeDomStubs(): void {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
}

function registryLayer() {
  return Layer.effect(
    EnvironmentRegistry,
    Effect.gen(function* () {
      const entries = yield* SubscriptionRef.make(
        new Map([
          [ENVIRONMENT_ID, { target: { _tag: "PrimaryConnectionTarget" } } as never],
        ]) as ReadonlyMap<EnvironmentId, never>,
      );
      return {
        entries,
        // The reporter only needs `entries` and `run`; `run` here stands in for
        // a healthy supervisor and simply executes the request effect.
        run: (_environmentId: EnvironmentId, effect: Effect.Effect<unknown, never, never>) =>
          effect,
      } as unknown as (typeof EnvironmentRegistry)["Service"];
    }),
  );
}

beforeEach(() => {
  requestCalls.length = 0;
  installDomStubs();
});

afterEach(() => {
  removeDomStubs();
});

/** The reporter debounces its queue by 250ms before sending. */
const settleReporter = Effect.sleep("700 millis").pipe(
  Effect.provide(backgroundActivityReporterLayer.pipe(Layer.provide(registryLayer()))),
);

it.live("reports client activity to every registered environment on startup", () =>
  Effect.gen(function* () {
    yield* settleReporter;

    const reports = requestCalls.filter(
      (call) => call.method === WS_METHODS.serverReportClientActivity,
    );
    expect(reports.length).toBeGreaterThan(0);
  }),
);

it.live("always claims the provider-status scope so the usage probe keeps a demand lease", () =>
  Effect.gen(function* () {
    yield* settleReporter;

    const report = requestCalls.find(
      (call) => call.method === WS_METHODS.serverReportClientActivity,
    )?.input as
      | { readonly scopes?: ReadonlyArray<{ readonly type: string }>; readonly visible?: boolean }
      | undefined;

    expect(report?.scopes?.some((scope) => scope.type === "provider-status")).toBe(true);
    expect(report?.visible).toBe(true);
    expect((report as { readonly environmentHost?: boolean } | undefined)?.environmentHost).toBe(
      true,
    );
  }),
);
