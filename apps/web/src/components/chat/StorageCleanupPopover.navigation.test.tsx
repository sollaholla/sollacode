// @vitest-environment happy-dom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { Route as threadRoute } from "../../routes/_chat.$environmentId.$threadId";
import { StorageCleanupPopover } from "./StorageCleanupPopover";

const state = vi.hoisted(() => ({
  project: false,
  thread: false,
  detail: false,
  listeners: new Set<() => void>(),
  start: vi.fn(),
}));
vi.mock("~/state/entities", async () => {
  const { useSyncExternalStore } = await import("react");
  function useReady(key: "project" | "thread" | "detail") {
    return useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
      () => state[key],
    );
  }
  return {
    useProject: (ref: unknown) => (useReady("project") && ref ? { id: "cleanup-project" } : null),
    useThreadShell: (ref: unknown) =>
      useReady("thread") && ref ? { id: "cleanup-thread", projectId: "cleanup-project" } : null,
    useThreadDetail: () => (useReady("detail") ? { id: "cleanup-thread" } : null),
    useThreadStatus: () => "synchronizing",
    useEnvironmentThreadRefs: () => [{ environmentId: "host", threadId: "unrelated-thread" }],
  };
});
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({
    label: "Host",
    connection: { phase: "connected" },
    serverConfig: { storageCleanupThreads: true },
  }),
  usePrimaryEnvironmentId: () => "host",
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: { snapshot: { _tag: "Some" } } }),
}));
vi.mock("~/state/shell", () => ({ environmentShell: { stateAtom: () => null } }));
vi.mock("~/state/server", () => ({ serverEnvironment: { startStorageCleanup: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.start }));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: object) => unknown) =>
    select({
      getDraftThreadByRef: () => null,
      hasDraftThreadsInEnvironment: () => false,
    }),
  finalizePromotedDraftThreadByRef: vi.fn(),
}));
vi.mock("~/lazyChatView", () => ({
  LazyChatView: ({ threadId }: { threadId: string }) => <div>Cleanup conversation: {threadId}</div>,
}));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  state.listeners.clear();
  vi.unstubAllGlobals();
});
function button(text: string) {
  const target = [...document.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(text),
  );
  if (!target) throw new Error(`Button missing: ${text}`);
  return target;
}

it("opens the created conversation through the real router when shell delivery follows the receipt", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.project = state.thread = state.detail = false;
  state.start.mockResolvedValue(
    AsyncResult.success({ projectId: "cleanup-project", threadId: "cleanup-thread" }),
  );
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <StorageCleanupPopover
          environmentId={EnvironmentId.make("host")}
          storage={{ freeBytes: 5e9, totalBytes: 1e12 }}
        />
        <Outlet />
      </>
    ),
  });
  const chatRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_chat",
    component: Outlet,
  });
  const indexRoute = createRoute({
    getParentRoute: () => chatRoute,
    path: "/",
    component: () => <div>Unrelated new draft</div>,
  });
  // Register the production file route in an isolated router, with its real redirect effect.
  const targetRoute = threadRoute.update({
    id: "/$environmentId/$threadId",
    path: "/$environmentId/$threadId",
    getParentRoute: () => chatRoute,
  } as Parameters<typeof threadRoute.update>[0]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([chatRoute.addChildren([indexRoute, targetRoute])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<RouterProvider router={router} />);
    await router.load();
  });
  await act(async () => button("5.0 GB").click());
  await act(async () => button("Create cleanup thread").click());
  expect(state.start).toHaveBeenCalledOnce();
  expect(router.state.location.pathname).toBe("/");

  // Even receiving the thread first is insufficient: its project is a separate shell update.
  await act(async () => {
    state.thread = true;
    state.listeners.forEach((listener) => listener());
  });
  expect(router.state.location.pathname).toBe("/");
  await act(async () => {
    state.project = true;
    state.listeners.forEach((listener) => listener());
  });
  expect(router.state.location.pathname).toBe("/host/cleanup-thread");
  expect(document.body.textContent).toContain("Cleanup conversation: cleanup-thread");
  expect(document.body.textContent).not.toContain("Unrelated new draft");
  await act(async () => {
    state.detail = true;
    state.listeners.forEach((listener) => listener());
  });
  expect(router.state.location.pathname).toBe("/host/cleanup-thread");
  expect(state.start).toHaveBeenCalledOnce();
});
