// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { PtyAdapter, type PtyProcess } from "../terminal/PtyAdapter.ts";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import {
  makeAntigravityAccountAuth,
  antigravityAuthScreen,
  parseAntigravityAuthStatus,
  readAntigravityAuthStatus,
} from "./antigravityAccountAuth.ts";

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const quota = "Gemini Models\tWeekly Limit Remaining\t0%\t2026-09-11T18:30:48Z\n";
const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=fixture&code_challenge=test";

describe("Antigravity native account switching", () => {
  it("recognizes native quota authentication even when no quota remains", () => {
    expect(parseAntigravityAuthStatus(quota, "").loggedIn).toBe(true);
    expect(
      parseAntigravityAuthStatus("gemini-3.8-flash-high\tGemini 3.8 Flash (High)", "").loggedIn,
    ).toBe(false);
    expect(parseAntigravityAuthStatus("Authentication required", "").loggedIn).toBe(false);
    const identity = "OAuth: authenticated successfully as fixture@example.com\n";
    expect(parseAntigravityAuthStatus(quota, identity)).toEqual({
      loggedIn: true,
      accountLabel: "fixture@example.com",
    });
    expect(parseAntigravityAuthStatus("Authentication required", identity).accountLabel).toBeNull();
  });
  it("recognizes ANSI auth screens without treating legal links as an OAuth flow", () => {
    expect(
      antigravityAuthScreen(
        `${authUrl}\nAfter authenticating, copy the code displayed in the browser\r\nand paste it below:\n authorization code...`,
      ),
    ).toMatchObject({ url: authUrl, waitingForCode: true });
    expect(
      antigravityAuthScreen(`\x1b[32m${authUrl}\x1b[0m\nEnter the authorization code:`),
    ).toMatchObject({ url: authUrl, waitingForCode: true });
    expect(
      antigravityAuthScreen("Terms of Service & Data Use https://policies.google.com/terms"),
    ).toMatchObject({ url: null, needsSetup: true });
    expect(antigravityAuthScreen("Gemini API Key Mode\n? for shortcuts").apiKeyMode).toBe(true);
    expect(antigravityAuthScreen("Google OAuth\nGemini API key")).toMatchObject({
      oauthChoice: true,
      apiKeyMode: false,
    });
    expect(
      antigravityAuthScreen(
        `${authUrl}\nIf you aren't automatically redirected, paste the authorization code below:`,
      ),
    ).toMatchObject({
      url: authUrl,
      waitingForCode: true,
    });
  });

  it.live.each(["success", "cancel", "rejected", "unverified", "setup", "api-key"] as const)(
    "handles %s with a scoped auth-only process",
    (scenario) =>
      Effect.gen(function* () {
        const dir = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-agy-auth-test-")),
          ),
          (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
        );
        const cache = NodePath.join(dir, ".gemini", "antigravity-cli", "cache");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(cache, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(cache, "onboarding.json"),
            scenario === "setup" ? '{"onboardingComplete":false}' : '{"onboardingComplete":true}',
          );
        });
        const binaryPath = NodePath.join(dir, "agy");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            binaryPath,
            `#!/usr/bin/env node\nprocess.stdout.write(${encodeString(quota)});process.exit(${scenario === "unverified" ? 1 : 0});\n`,
            { mode: 0o755 },
          ),
        );
        const registered = yield* Deferred.make<void>();
        let emit: (data: string) => void = () => {};
        let submit: ((code: string) => Effect.Effect<void, Error>) | undefined;
        const progress: Array<{ authUrl?: string; waitingForCode?: boolean }> = [];
        const disposeData = vi.fn();
        const disposeExit = vi.fn();
        const child: PtyProcess = {
          pid: 123,
          resize: vi.fn(),
          kill: vi.fn(),
          onData: (cb) => {
            emit = cb;
            return disposeData;
          },
          onExit: () => disposeExit,
          write: vi.fn((data: string) => {
            if (data === "/logout\r") emit("Google OAuth\nGemini API key");
            if (data === "\r")
              emit(
                `${authUrl}\nAfter authenticating, copy the code displayed in the browser and paste it below:`,
              );
            if (data === "private-fixture-code\r")
              emit(
                scenario === "rejected"
                  ? "Invalid authorization code"
                  : "Authentication successful!\n? for shortcuts",
              );
          }),
        };
        const spawn = vi.fn(() => Effect.succeed(child));
        const capability = makeAntigravityAccountAuth({
          binaryPath,
          environment: { ...process.env, HOME: dir },
          cwd: dir,
        });
        const run = capability
          .switchAccount({
            wasAuthenticated: true,
            onProgress: (p) => progress.push(p),
            onSubmitCode: (callback) => {
              submit = callback;
              Deferred.doneUnsafe(registered, Effect.void);
            },
          })
          .pipe(Effect.provideService(PtyAdapter, { spawn }), Effect.scoped);
        if (scenario === "setup") {
          const result = yield* Effect.result(run);
          expect(result._tag).toBe("Failure");
          expect(spawn).not.toHaveBeenCalled();
          return;
        }
        const fiber = yield* run.pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(registered);
        emit(scenario === "api-key" ? "Gemini API Key Mode\n? for shortcuts" : "? for shortcuts");
        if (scenario === "cancel") {
          yield* Fiber.interrupt(fiber);
        } else {
          if (scenario !== "api-key") {
            expect(progress).toContainEqual({ authUrl, waitingForCode: true });
            yield* submit!("private-fixture-code");
          }
          const result = yield* Fiber.join(fiber);
          expect(result._tag).toBe(scenario === "success" ? "Success" : "Failure");
        }
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(disposeData).toHaveBeenCalledTimes(1);
        expect(disposeExit).toHaveBeenCalledTimes(1);
        expect(progress.map((entry) => entry.authUrl ?? "").join(" ")).not.toContain(
          "private-fixture-code",
        );
        const call = spawn.mock.calls[0];
        expect(call).toBeDefined();
        expect(child.write).not.toHaveBeenCalledWith("-i /logout");
        if (scenario === "api-key") expect(child.write).not.toHaveBeenCalled();
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.live.skipIf(process.env.SOLLA_TEST_LIVE_AGY_AUTH !== "1")(
  "reaches the real native code prompt in an isolated home and cancels cleanly",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-agy-native-auth-")),
        ),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const cache = NodePath.join(dir, ".gemini", "antigravity-cli", "cache");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(cache, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(cache, "onboarding.json"),
          '{"onboardingComplete":true}',
        );
      });
      const codePrompt = yield* Deferred.make<void>();
      let authUrl: string | undefined;
      const fiber = yield* makeAntigravityAccountAuth({
        binaryPath: "/opt/homebrew/bin/agy",
        environment: { ...process.env, HOME: dir },
        cwd: dir,
      })
        .switchAccount({
          wasAuthenticated: false,
          onProgress: (progress) => {
            authUrl = progress.authUrl ?? authUrl;
            if (progress.waitingForCode) Deferred.doneUnsafe(codePrompt, Effect.void);
          },
          onSubmitCode: () => {},
        })
        .pipe(Effect.scoped, Effect.forkScoped);
      yield* Deferred.await(codePrompt).pipe(Effect.timeout("25 seconds"));
      expect(authUrl).toMatch(/^https:\/\//);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(NodePtyAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  30_000,
);

it.live.skipIf(process.env.SOLLA_TEST_LIVE_AGY_AUTH !== "1")(
  "reads the real signed-in identity without generating or changing accounts",
  () =>
    Effect.gen(function* () {
      const status = yield* readAntigravityAuthStatus({
        binaryPath: "/opt/homebrew/bin/agy",
        environment: process.env,
      });
      expect(status.loggedIn).toBe(true);
      expect(status.accountLabel).toMatch(/^[^\s@]+@[^\s@]+$/);
    }).pipe(Effect.provide(NodeServices.layer)),
  20_000,
);
