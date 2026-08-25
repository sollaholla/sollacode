import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "../../preview/Manager.ts";
import * as PreviewIpc from "./preview.ts";

const { fromPartition } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

describe("preview IPC methods", () => {
  beforeEach(() => {
    fromPartition.mockClear();
  });

  it("does not access the Electron session while the module loads", async () => {
    await expect(import("./preview.ts")).resolves.toBeDefined();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  effectIt.effect("rejects invalid webContents ids before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, null as never), Effect.exit),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        expect(fromPartition).not.toHaveBeenCalled();
      },
    ),
  );

  effectIt.effect("encodes composite runtime tab ids in automation status", () => {
    const tabId = JSON.stringify([
      "6e0f84a4-7d9a-4d13-99da-d824bbd64a2f",
      "ce4c14c6-6784-4244-a64c-9317eadc61b2",
      "9ea6a44c-3b51-4919-a275-dcc6acbc9317",
      "tab_f6081bc1-1fdb-4fc8-9441-183bdea7e152",
    ]);
    expect(tabId.length).toBeGreaterThan(128);
    const manager = PreviewManager.PreviewManager.of({
      automationStatus: () =>
        Effect.succeed({
          available: true,
          visible: false,
          tabId,
          url: "https://example.com",
          title: "Example",
          loading: false,
        }),
    } as never);

    return Effect.map(
      PreviewIpc.automationStatus
        .handler({ tabId })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, manager)),
      (status) => {
        expect(status).toMatchObject({ tabId, available: true });
      },
    );
  });
});
