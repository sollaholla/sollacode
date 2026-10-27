import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceState } from "../../state/workspaceModel";
import { deriveHomeEmptyState } from "./home-empty-state";

const initial: WorkspaceState = {
  isLoadingConnections: false,
  hasConnections: false,
  hasLoadedShellSnapshot: false,
  hasPendingShellSnapshot: false,
  hasReadyEnvironment: false,
  hasConnectingEnvironment: false,
  connectingEnvironments: [],
  connectionState: "available",
  connectionError: null,
  shellSnapshotError: null,
  latestCachedSnapshotReceivedAt: null,
  networkStatus: "online",
};
const emptyState = (overrides: Partial<WorkspaceState>, projectCount = 0) =>
  deriveHomeEmptyState({ catalogState: { ...initial, ...overrides }, projectCount });

describe("home empty-state next action", () => {
  it("waits for saved connections before suggesting first-time setup", () => {
    expect(emptyState({ isLoadingConnections: true })).toMatchObject({
      loading: true,
      action: null,
    });
    expect(emptyState({})).toMatchObject({ loading: false, action: "connect" });
  });

  it("does not ask users to add a duplicate computer during reconnect", () => {
    expect(
      emptyState({
        hasConnections: true,
        hasConnectingEnvironment: true,
        connectionState: "reconnecting",
      }),
    ).toMatchObject({ loading: true, action: null });
    expect(
      emptyState({
        hasConnections: true,
        connectionState: "error",
        connectionError: "Connection expired",
      }),
    ).toMatchObject({ loading: false, action: "connections", detail: "Connection expired" });
  });

  it("offers connection recovery while offline even if a cached empty snapshot exists", () => {
    expect(
      emptyState({
        hasConnections: true,
        hasLoadedShellSnapshot: true,
        networkStatus: "offline",
        connectionState: "offline",
      }),
    ).toMatchObject({ title: "You are offline", action: "connections" });
  });

  it("waits for the first snapshot before offering to add a project", () => {
    expect(
      emptyState({
        hasConnections: true,
        hasReadyEnvironment: true,
        hasPendingShellSnapshot: true,
      }),
    ).toMatchObject({ loading: true, action: null });
    expect(
      emptyState({
        hasConnections: true,
        hasReadyEnvironment: true,
        shellSnapshotError: "Workspace unavailable",
      }),
    ).toMatchObject({ loading: false, action: "connections", detail: "Workspace unavailable" });
  });

  it("offers a direct project or task action after pairing", () => {
    const connected = {
      hasConnections: true,
      hasReadyEnvironment: true,
      hasLoadedShellSnapshot: true,
    };
    expect(emptyState(connected)).toMatchObject({
      action: "project",
      actionLabel: "Add a project",
    });
    expect(emptyState(connected, 1)).toMatchObject({ action: "task", actionLabel: "New task" });
  });

  it("lets a ready computer be used when a different saved computer is offline", () => {
    expect(
      emptyState(
        {
          hasConnections: true,
          hasReadyEnvironment: true,
          hasLoadedShellSnapshot: true,
          connectionError: "Other computer unavailable",
        },
        1,
      ),
    ).toMatchObject({ action: "task", loading: false });
  });
});
