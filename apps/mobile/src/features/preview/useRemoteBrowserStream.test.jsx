// @vitest-environment happy-dom
// The native hook uses React's subscription lifecycle; this renderer exercises
// it without starting a simulator or mocking React's hooks.
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRemoteBrowserStream } from "./useRemoteBrowserStream";
const mocks = vi.hoisted(() => ({
  focused: true,
  appState: {
    currentState: "active",
    addEventListener: vi.fn(),
  },
  subscribe: vi.fn(),
  remoteFrames: vi.fn(),
  picture: vi.fn(),
}));
vi.mock("@effect/atom-react", async () => {
  const { createContext } = await import("react");
  return { RegistryContext: createContext({ subscribe: mocks.subscribe }) };
});
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (effect) =>
      useEffect(() => (mocks.focused ? effect() : undefined), [effect, mocks.focused]),
  };
});
vi.mock("react-native", () => ({
  AppState: mocks.appState,
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3 }),
}));
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => ({
    environment: { capabilities: { remotePreviewFrames: true } },
  }),
}));
vi.mock("../../state/preview", () => ({
  previewEnvironment: { remoteFrames: mocks.remoteFrames },
}));
const keyframe = {
  type: "keyframe",
  sequence: 0,
  width: 640,
  height: 480,
  mimeType: "image/jpeg",
  data: "picture",
};
describe("native pushed preview recovery", () => {
  let root;
  let container;
  let changeAppState;
  let reportSnapshotError;
  let removeAppState;
  const subscriptions = [];
  function Harness() {
    const [frame, setFrame] = useState(null);
    const [error, setError] = useState(null);
    reportSnapshotError = () => setError("Snapshot capture failed");
    const { pollNeeded } = useRemoteBrowserStream({
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      tabId: "tab",
      onFrame: setFrame,
      onPicture: () => {
        mocks.picture();
        setError(null);
      },
    });
    return (
      <div data-polling={pollNeeded} data-picture={frame?.screenshot.data}>
        {error}
      </div>
    );
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.focused = true;
    mocks.appState.currentState = "active";
    mocks.picture.mockReset();
    mocks.remoteFrames.mockReset();
    subscriptions.length = 0;
    mocks.subscribe.mockReset().mockImplementation((_atom, receive) => {
      const unsubscribe = vi.fn();
      subscriptions.push({ receive, unsubscribe });
      return unsubscribe;
    });
    removeAppState = vi.fn();
    mocks.appState.addEventListener.mockReset().mockImplementation((_kind, listener) => {
      changeAppState = (state) => {
        mocks.appState.currentState = state;
        listener(state);
      };
      return { remove: removeAppState };
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("clears a snapshot error on a recovered keyframe, but not a state update", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => vi.advanceTimersByTimeAsync(3_001));
    expect(container.firstElementChild?.getAttribute("data-polling")).toBe("true");
    await act(async () => reportSnapshotError());
    await act(async () =>
      subscriptions[0].receive(
        AsyncResult.success([
          {
            type: "state",
            state: { url: "https://example.com", title: "Example", loading: false },
          },
        ]),
      ),
    );
    expect(container.textContent).toBe("Snapshot capture failed");
    expect(mocks.picture).not.toHaveBeenCalled();
    await act(async () => subscriptions[0].receive(AsyncResult.success([keyframe])));
    expect(container.textContent).toBe("");
    expect(container.firstElementChild?.getAttribute("data-polling")).toBe("false");
    expect(container.firstElementChild?.getAttribute("data-picture")).toBe("picture");
    expect(mocks.picture).toHaveBeenCalledOnce();
  });
  it("ignores old callbacks after backgrounding or losing focus and clears its grace timer", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => changeAppState("background"));
    expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => subscriptions[0].receive(AsyncResult.success([keyframe])));
    expect(mocks.picture).not.toHaveBeenCalled();
    await act(async () => changeAppState("active"));
    expect(subscriptions).toHaveLength(2);
    mocks.focused = false;
    await act(async () => root.render(<Harness />));
    expect(subscriptions[1].unsubscribe).toHaveBeenCalledOnce();
    expect(removeAppState).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => subscriptions[1].receive(AsyncResult.success([keyframe])));
    expect(mocks.picture).not.toHaveBeenCalled();
  });
});
