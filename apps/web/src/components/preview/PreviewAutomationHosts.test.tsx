// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { PreviewAutomationHosts } from "./PreviewAutomationHosts";

const mocks = vi.hoisted(() => ({
  createHost: vi.fn(),
  dispose: vi.fn(),
  setDemand: vi.fn(),
  refresh: vi.fn(),
  consumerCreated: vi.fn(),
  consumerDisposed: vi.fn(),
  ticketCommand: vi.fn(async (_input: unknown) => ({
    _tag: "Success",
    value: { ticket: "fresh" },
  })),
}));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "env", entry: { target: { _tag: "PrimaryConnectionTarget" } } },
    ],
  }),
  usePrimaryEnvironmentId: () => "env",
  useEnvironmentHttpBaseUrl: () => "http://example.test",
}));
vi.mock("~/state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("~/state/session", () => ({
  readPreparedConnection: () => ({ socketUrl: "ws://example.test/ws" }),
}));
vi.mock("~/state/preview", async () => {
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const requests = Atom.make(
    AsyncResult.success({ type: "connected", connectionId: "connection" }),
  );
  return { previewEnvironment: { automationRequests: () => requests, hostMediaTicket: "ticket" } };
});
vi.mock("~/state/use-atom-command", () => ({
  // Match the real hook: a fresh function on every render.
  useAtomCommand: (command: string) => (input: unknown) =>
    command === "ticket"
      ? mocks.ticketCommand(input)
      : Promise.resolve({ _tag: "Success", value: undefined }),
}));
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async () => ({ _tag: "Success", value: [] }),
}));
vi.mock("./previewBridge", () => ({
  previewBridge: {
    automation: { renewForeground: async () => undefined },
    getTabVideoSource: async () => null,
    getTabAudioSource: async () => null,
    onStateChange: () => () => undefined,
    onTabVideoSourceChanged: () => () => undefined,
  },
}));
vi.mock("./tabAudioStreamer", () => ({ canCaptureTabAudio: () => false }));
vi.mock("./remoteFrames/remoteFrameEncoder", () => ({ canEncodeRemoteFrames: () => false }));
vi.mock("./remoteMedia/previewMediaHost", () => ({
  canPublishPreviewMedia: () => true,
  capturePreviewTab: vi.fn(),
  createPreviewMediaHost: (options: unknown) => {
    mocks.createHost(options);
    return {
      setDemand: mocks.setDemand,
      refresh: mocks.refresh,
      dispose: mocks.dispose,
      stateChanged: vi.fn(),
      sourceChanged: vi.fn(),
      hasRuntime: () => false,
    };
  },
}));
vi.mock("./previewAutomationRequestConsumer", () => ({
  createPreviewAutomationRequestConsumerAtom: (options: {
    connectionAtom: Atom.Writable<string | null>;
    handleMediaDemand: (tabs: ReadonlyArray<unknown>) => void;
  }) => {
    mocks.consumerCreated();
    return Atom.make((get) => {
      get.mount(options.connectionAtom);
      get.set(options.connectionAtom, "connection");
      options.handleMediaDemand([{ threadId: "thread", tabId: "tab" }]);
      get.addFinalizer(() => {
        mocks.consumerDisposed();
        options.handleMediaDemand([]);
      });
    }).pipe(Atom.setIdleTTL(0));
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("keeps its video publisher and demand consumer alive across ordinary React rerenders", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const registry = AtomRegistry.make();
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const render = () =>
    act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <PreviewAutomationHosts />
        </RegistryContext.Provider>,
      );
    });
  try {
    await render();
    const hostCount = mocks.createHost.mock.calls.length;
    const consumerCount = mocks.consumerCreated.mock.calls.length;
    expect(hostCount).toBe(1);
    expect(consumerCount).toBe(1);
    await render();
    expect(mocks.createHost).toHaveBeenCalledTimes(hostCount);
    expect(mocks.consumerCreated).toHaveBeenCalledTimes(consumerCount);
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(mocks.consumerDisposed).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    registry.dispose();
    element.remove();
  }
  expect(mocks.dispose).toHaveBeenCalledOnce();
  expect(mocks.consumerDisposed).toHaveBeenCalledOnce();
});
