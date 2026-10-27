import type { WorkspaceState } from "../../state/workspaceModel";

export type HomeEmptyAction = "connect" | "connections" | "project" | "task";

export function deriveHomeEmptyState(input: {
  readonly catalogState: WorkspaceState;
  readonly projectCount: number;
}): {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
  readonly action: HomeEmptyAction | null;
  readonly actionLabel?: string;
} {
  const state = input.catalogState;
  if (state.isLoadingConnections) {
    return {
      title: "Loading your workspace",
      detail: "Checking saved computers on this device.",
      loading: true,
      action: null,
    };
  }
  if (!state.hasConnections) {
    return {
      title: "Connect your computer",
      detail:
        "Keep working on the projects and threads from Solla Code on your computer. Scan its QR code or paste a connection link to get started.",
      loading: false,
      action: "connect",
      actionLabel: "Connect a computer",
    };
  }
  if (!state.hasReadyEnvironment && state.hasConnectingEnvironment && !state.connectionError) {
    return {
      title: "Connecting to your computer",
      detail: "Your projects and threads will appear when the connection is ready.",
      loading: true,
      action: null,
    };
  }
  if (!state.hasReadyEnvironment) {
    return {
      title: state.networkStatus === "offline" ? "You are offline" : "Your computer is unavailable",
      detail:
        state.connectionError ??
        "Keep Solla Code open on your computer and check that both devices can reach each other.",
      loading: false,
      action: "connections",
      actionLabel: "Manage connections",
    };
  }
  if (!state.hasLoadedShellSnapshot && !state.shellSnapshotError) {
    return {
      title: "Loading your workspace",
      detail: "Getting projects and threads from your computer.",
      loading: true,
      action: null,
    };
  }
  if (state.shellSnapshotError && !state.hasLoadedShellSnapshot) {
    return {
      title: "Could not load your workspace",
      detail: state.shellSnapshotError,
      loading: false,
      action: "connections",
      actionLabel: "Manage connections",
    };
  }
  if (input.projectCount === 0) {
    return {
      title: "Add your first project",
      detail:
        "Choose a folder or repository on your connected computer. Your files stay there while you work from this device.",
      loading: false,
      action: "project",
      actionLabel: "Add a project",
    };
  }
  return {
    title: "Start your first thread",
    detail: "Choose a project and tell your agent what you want to work on.",
    loading: false,
    action: "task",
    actionLabel: "New task",
  };
}
