import type {
  PreviewCloseInput,
  PreviewCloseResult,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";

import { closePreviewSession, reconcileLegacyPreviewClose } from "./closePreviewSession";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: {
    _tag: "Success",
    url: "http://localhost:3000/",
    title: "Local app",
  },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-18T19:00:00.000Z",
};

beforeEach(resetPreviewStateForTests);

describe("closePreviewSession", () => {
  it("suppresses stale server snapshots while the close is in flight", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot);
    let finishClose: (() => void) | undefined;
    const closePreview = vi.fn(
      (_input: PreviewCloseInput) =>
        new Promise<ReturnType<typeof AsyncResult.success<PreviewCloseResult | undefined>>>(
          (resolve) => {
            finishClose = () => resolve(AsyncResult.success(undefined));
          },
        ),
    );

    const closing = closePreviewSession({
      closePreview: ({ input }) => closePreview(input),
      snapshot,
      tabId: snapshot.tabId,
      threadRef,
    });

    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
    applyPreviewServerSnapshot(threadRef, snapshot);
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});

    finishClose?.();
    await closing;
    expect(closePreview).toHaveBeenCalledWith({ threadId: "thread-1", tabId: "tab-1" });
  });

  it("restores the last snapshot when the server close fails", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot);

    const result = await closePreviewSession({
      closePreview: async () => AsyncResult.failure(Cause.fail(new Error("close failed"))),
      snapshot,
      tabId: snapshot.tabId,
      threadRef,
    });

    expect(result._tag).toBe("Failure");
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(snapshot);
    expect(readThreadPreviewState(threadRef).sessions).toEqual({ [snapshot.tabId]: snapshot });
  });

  it("applies the authoritative replacement returned by close", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot);
    const replacement: PreviewSessionSnapshot = {
      ...snapshot,
      tabId: "tab-replacement",
      navStatus: { _tag: "Idle" },
      updatedAt: "2026-06-18T19:01:00.000Z",
    };

    const result = await closePreviewSession({
      closePreview: async () =>
        AsyncResult.success({
          sessions: [replacement],
          closedTabIds: [snapshot.tabId],
          serverEpoch: "epoch-1",
          revision: 2,
        }),
      snapshot,
      tabId: snapshot.tabId,
      threadRef,
    });

    expect(result._tag).toBe("Success");
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(replacement);
    expect(readThreadPreviewState(threadRef).sessions).toEqual({
      [replacement.tabId]: replacement,
    });
  });

  it("opens a blank replacement when a legacy void close leaves no server tabs", async () => {
    applyPreviewServerSnapshot(threadRef, snapshot);
    const closeResult = await closePreviewSession({
      closePreview: async () => AsyncResult.success(undefined),
      snapshot,
      tabId: snapshot.tabId,
      threadRef,
    });
    expect(closeResult).toEqual(AsyncResult.success(undefined));
    if (closeResult._tag === "Failure") throw new Error("Expected legacy close success");

    const replacement: PreviewSessionSnapshot = {
      ...snapshot,
      tabId: "tab-legacy-replacement",
      navStatus: { _tag: "Idle" },
      updatedAt: "2026-06-18T19:02:00.000Z",
    };
    const listPreviews = vi.fn(async () =>
      AsyncResult.success({
        sessions: [],
        serverEpoch: "legacy-epoch",
        revision: 2,
      }),
    );
    const openBlankPreview = vi.fn(async () => AsyncResult.success(replacement));

    await expect(
      reconcileLegacyPreviewClose({
        closeResult: closeResult.value,
        listPreviews,
        openBlankPreview,
        retainBlankTab: true,
        threadRef,
      }),
    ).resolves.toBe(true);
    expect(listPreviews).toHaveBeenCalledOnce();
    expect(openBlankPreview).toHaveBeenCalledOnce();
    expect(readThreadPreviewState(threadRef).sessions).toEqual({
      [replacement.tabId]: replacement,
    });
  });

  it("leaves an ordinary legacy thread empty after its final tab closes", async () => {
    const listPreviews = vi.fn(async () =>
      AsyncResult.success({
        sessions: [],
        serverEpoch: "legacy-epoch",
        revision: 2,
      }),
    );
    const openBlankPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await expect(
      reconcileLegacyPreviewClose({
        closeResult: undefined,
        listPreviews,
        openBlankPreview,
        retainBlankTab: false,
        threadRef,
      }),
    ).resolves.toBe(false);
    expect(listPreviews).toHaveBeenCalledOnce();
    expect(openBlankPreview).not.toHaveBeenCalled();
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
  });
});
