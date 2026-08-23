import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const sessionsAtom = { kind: "preview-list" };
  const eventsAtom = { kind: "preview-events" };
  return {
    sessionsAtom,
    eventsAtom,
    list: vi.fn(() => sessionsAtom),
    events: vi.fn(() => eventsAtom),
    useAtomValue: vi.fn(),
  };
});

vi.mock("@effect/atom-react", () => ({ useAtomValue: mocks.useAtomValue }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: { list: mocks.list, events: mocks.events },
}));
vi.mock("~/previewStateStore", () => ({
  applyPreviewServerEvent: vi.fn(),
  readThreadPreviewState: vi.fn(() => ({ serverEpoch: null })),
  reconcilePreviewServerSessions: vi.fn(),
}));

import { usePreviewSession } from "./usePreviewSession";

function SessionConsumer() {
  usePreviewSession(scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1")));
  return null;
}

describe("usePreviewSession", () => {
  it("mounts preview.list directly instead of waiting for the event sync atom", () => {
    renderToStaticMarkup(<SessionConsumer />);

    expect(mocks.list).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { threadId: "thread-1" },
    });
    expect(mocks.useAtomValue).toHaveBeenCalledWith(mocks.sessionsAtom);
  });
});
