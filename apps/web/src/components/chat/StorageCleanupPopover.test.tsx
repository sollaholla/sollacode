// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { StorageCleanupPopover } from "./StorageCleanupPopover";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  navigate: vi.fn(),
  environment: vi.fn(),
  project: vi.fn(),
  thread: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => ({ environmentId: "host", threadId: "current" }),
}));
vi.mock("~/state/environments", () => ({ useEnvironment: () => mocks.environment() }));
vi.mock("~/state/entities", () => ({
  useProject: (ref: unknown) => (ref ? mocks.project() : null),
  useThreadShell: (ref: unknown) => (ref ? mocks.thread() : null),
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { startStorageCleanup: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.start }));
const environmentId = EnvironmentId.make("host");
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.environment.mockReturnValue({
    label: "MacBook",
    connection: { phase: "connected" },
    serverConfig: { storageCleanupThreads: true },
  });
  mocks.project.mockReturnValue({ id: "cleanup-project" });
  mocks.thread.mockReturnValue({ id: "cleanup-thread" });
  mocks.start
    .mockReset()
    .mockResolvedValue(
      AsyncResult.success({ projectId: "cleanup-project", threadId: "cleanup-thread" }),
    );
  mocks.navigate.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <StorageCleanupPopover
        environmentId={environmentId}
        storage={{ freeBytes: 5e9, totalBytes: 1e12 }}
      />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("opens a descriptive popup and only creates a cleanup thread after the action is tapped", async () => {
  await click(button("5.0 GB"));
  expect(document.body.textContent).toContain("login cookies");
  expect(mocks.start).not.toHaveBeenCalled();
  await click(button("Create cleanup thread"));
  expect(mocks.start).toHaveBeenCalledOnce();
  const request = mocks.start.mock.calls[0]![0];
  expect(request.environmentId).toBe("host");
  expect(request.input).not.toHaveProperty("projectId");
  expect(request.input).not.toHaveProperty("bootstrap");
  expect(document.body.textContent).not.toContain("New thread in");
  expect(request.input.threadId).not.toBe("current");
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "host", threadId: "cleanup-thread" },
  });
});
it("blocks repeated taps even if the popup is closed and reopened while creation is pending", async () => {
  let finish!: (value: ReturnType<typeof AsyncResult.success>) => void;
  mocks.start.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click(button("5.0 GB"));
  await click(button("Create cleanup thread"));
  expect(button("Creating thread").disabled).toBe(true);
  expect(mocks.navigate).not.toHaveBeenCalled();
  await click(button("5.0 GB"));
  await click(button("5.0 GB"));
  expect(button("Creating thread").disabled).toBe(true);
  await click(button("Creating thread"));
  expect(mocks.start).toHaveBeenCalledOnce();
  await act(async () =>
    finish(AsyncResult.success({ projectId: "cleanup-project", threadId: "cleanup-thread" })),
  );
});
it("shows creation errors and retries the same request instead of creating a second thread", async () => {
  mocks.start.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail(new Error("Storage unavailable"))),
  );
  await click(button("5.0 GB"));
  await click(button("Create cleanup thread"));
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Storage unavailable");
  expect(mocks.navigate).not.toHaveBeenCalled();
  const first = mocks.start.mock.calls[0]![0];
  await click(button("Create cleanup thread"));
  expect(mocks.start.mock.calls[1]![0]).toEqual(first);
});
it("disables creation while the storage host is offline", async () => {
  mocks.environment.mockReturnValue({ label: "MacBook", connection: { phase: "offline" } });
  await click(button("5.0 GB"));
  expect(button("Create cleanup thread").disabled).toBe(true);
  expect(mocks.start).not.toHaveBeenCalled();
});

it("creates a dedicated thread without reading the current route or any project list", async () => {
  await click(button("5.0 GB"));
  expect(document.body.textContent).toContain("Dedicated workspace on MacBook");
  expect(button("Create cleanup thread").disabled).toBe(false);
  await click(button("Create cleanup thread"));
  expect(mocks.start).toHaveBeenCalledOnce();
});

it("explains when a connected host is too old instead of falling back to a project", async () => {
  mocks.environment.mockReturnValue({
    label: "Old host",
    connection: { phase: "connected" },
    serverConfig: {},
  });
  await click(button("5.0 GB"));
  expect(button("Create cleanup thread").disabled).toBe(true);
  expect(document.body.textContent).toContain("Update Solla Code on this machine");
  expect(mocks.start).not.toHaveBeenCalled();
});

async function deliverShell({ project, thread }: { project: boolean; thread: boolean }) {
  mocks.project.mockReturnValue(project ? { id: "cleanup-project" } : null);
  mocks.thread.mockReturnValue(thread ? { id: "cleanup-thread" } : null);
  await act(async () =>
    root.render(
      <StorageCleanupPopover
        environmentId={environmentId}
        storage={{ freeBytes: 5e9, totalBytes: 1e12 }}
      />,
    ),
  );
}
it("waits for both records, including after the popup is dismissed", async () => {
  await deliverShell({ project: false, thread: false });
  await click(button("5.0 GB"));
  await click(button("Create cleanup thread"));
  expect(button("Opening thread").disabled).toBe(true);
  expect(mocks.navigate).not.toHaveBeenCalled();
  await click(button("5.0 GB"));
  await deliverShell({ project: false, thread: true });
  expect(mocks.navigate).not.toHaveBeenCalled();
  await deliverShell({ project: true, thread: true });
  expect(mocks.navigate).toHaveBeenCalledOnce();
  expect(mocks.start).toHaveBeenCalledOnce();
});
it("waits for the thread even if its project arrives first", async () => {
  await deliverShell({ project: true, thread: false });
  await click(button("5.0 GB"));
  await click(button("Create cleanup thread"));
  expect(mocks.navigate).not.toHaveBeenCalled();
  await deliverShell({ project: true, thread: true });
  expect(mocks.navigate).toHaveBeenCalledOnce();
});
it("retries opening the acknowledged thread without starting another cleanup", async () => {
  mocks.navigate.mockRejectedValueOnce(new Error("Navigation interrupted"));
  await click(button("5.0 GB"));
  await click(button("Create cleanup thread"));
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Navigation interrupted");
  await click(button("Open cleanup thread"));
  expect(mocks.start).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledTimes(2);
});
