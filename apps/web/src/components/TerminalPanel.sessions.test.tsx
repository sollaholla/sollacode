// @vitest-environment happy-dom
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PersistentThreadTerminalPanel } from "./ChatView";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import type ThreadTerminalDrawer from "./ThreadTerminalDrawer";

const metadata = vi.hoisted(() => ({
  ids: [] as string[],
  loaded: false,
  listeners: new Set<() => void>(),
}));
vi.mock("../state/terminalSessions", async (original) => {
  const { useMemo, useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    metadata.listeners.add(listener);
    return () => {
      metadata.listeners.delete(listener);
    };
  };
  return {
    ...(await original<typeof import("../state/terminalSessions")>()),
    useKnownTerminalSessions: () => {
      const ids = useSyncExternalStore(subscribe, () => metadata.ids);
      return useMemo(
        () => ids.map((terminalId) => ({ target: { terminalId }, state: { summary: null } })),
        [ids],
      );
    },
    useTerminalMetadataLoaded: () => useSyncExternalStore(subscribe, () => metadata.loaded),
  };
});
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: "dark" }) }));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useThread: () => ({ environmentId: "host", projectId: "project", worktreePath: null }),
  useProject: () => ({ id: "project", workspaceRoot: "/workspace" }),
}));
vi.mock("./ThreadTerminalDrawer", () => ({
  default: (props: ComponentProps<typeof ThreadTerminalDrawer>) => (
    <div>
      <div data-active-terminal>{props.activeTerminalId}</div>
      {props.terminalIds.map((id) => (
        <button key={id} onClick={() => props.onActiveTerminalChange(id)}>
          {id}
        </button>
      ))}
    </div>
  ),
}));
const threadRef = scopeThreadRef(EnvironmentId.make("host"), ThreadId.make("thread"));
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
function Panel() {
  const surface = useRightPanelStore((s) =>
    selectActiveRightPanelSurface(s.byThreadKey, threadRef),
  );
  if (surface?.kind !== "terminal") return null;
  return (
    <PersistentThreadTerminalPanel
      threadRef={threadRef}
      surface={surface}
      launchContext={null}
      focusRequestId={0}
      keybindings={[]}
      onNewTerminal={() => undefined}
      onCloseTerminal={() => undefined}
      onAddTerminalContext={() => undefined}
      onActiveTerminalChange={(id) =>
        useRightPanelStore.getState().activateTerminal(threadRef, surface.id, id)
      }
    />
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  metadata.ids = [];
  metadata.loaded = false;
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    pendingOpenTerminalIdsByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("renders each new server session in the sidebar without mounting the main terminal view", async () => {
  for (const id of ["term-1", "term-2", "term-3"]) {
    await act(async () => {
      useRightPanelStore.getState().openTerminal(threadRef, id);
      metadata.ids = [...metadata.ids, id];
      metadata.loaded = true;
      metadata.listeners.forEach((listener) => listener());
      root.render(<Panel />);
    });
    expect([...container.querySelectorAll("button")].map((el) => el.textContent)).toEqual(
      metadata.ids,
    );
    expect(container.querySelector("[data-active-terminal]")?.textContent).toBe(id);
  }
  await act(async () => container.querySelector("button")?.click());
  expect(container.querySelector("[data-active-terminal]")?.textContent).toBe("term-1");
});

it("keeps a pending local open during metadata loading and removes a remotely closed session", async () => {
  await act(async () => {
    useTerminalUiStateStore.getState().ensureTerminal(threadRef, "term-1");
    useRightPanelStore.getState().openTerminal(threadRef, "term-1");
    metadata.listeners.forEach((listener) => listener());
    root.render(<Panel />);
  });
  expect(container.querySelector("button")?.textContent).toBe("term-1");
  await act(async () => {
    metadata.loaded = true;
    metadata.listeners.forEach((listener) => listener());
    root.render(<Panel />);
  });
  expect(container.querySelector("button")?.textContent).toBe("term-1");
  await act(async () => {
    metadata.ids = ["term-1"];
    metadata.listeners.forEach((listener) => listener());
    root.render(<Panel />);
  });
  await act(async () => {
    metadata.ids = [];
    metadata.listeners.forEach((listener) => listener());
    root.render(<Panel />);
  });
  expect(container.querySelector("button")).toBeNull();
});
