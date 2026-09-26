import { beforeEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { voiceNoteRuntimeStartupLayer } from "./voiceNoteRuntimeStartup.ts";

const prepare = vi.hoisted(() => vi.fn());
vi.mock("./voiceNoteMlxRuntime.ts", () => ({
  ensureVoiceMlxRuntime: prepare,
  isVoiceMlxSupported: (platform: string, arch: string) =>
    platform === "darwin" && arch === "arm64",
}));
const desktop = {
  baseDir: "/isolated/solla",
  desktop: true,
  development: false,
  platform: "darwin",
  arch: "arm64",
} as const;
beforeEach(() => {
  prepare.mockReset();
});

describe("local speech runtime startup", () => {
  it.effect.each([
    { desktop: false },
    { development: true },
    { platform: "win32" as const },
    { arch: "x64" },
  ])("does not install for an ineligible host %o", (override) =>
    Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(voiceNoteRuntimeStartupLayer({ ...desktop, ...override })));
      expect(prepare).not.toHaveBeenCalled();
    }),
  );

  it.effect("starts independently and cancels setup when the server scope closes", () =>
    Effect.gen(function* () {
      let started!: () => void;
      let stopped!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const cancelled = new Promise<void>((resolve) => {
        stopped = resolve;
      });
      prepare.mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                stopped();
                reject(signal.reason);
              },
              { once: true },
            );
            started();
          }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(voiceNoteRuntimeStartupLayer(desktop));
          yield* Effect.promise(() => ready);
          // Reaching this while setup is unresolved proves it does not block startup.
          expect(prepare).toHaveBeenCalledWith(
            expect.objectContaining({ baseDir: desktop.baseDir }),
          );
        }),
      );
      yield* Effect.promise(() => cancelled);
    }),
  );
});
