import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  surfaceProps: [] as Array<Record<string, unknown>>,
  mirrorProps: [] as Array<Record<string, unknown>>,
  openBrowser: vi.fn(),
  close: vi.fn(),
}));

vi.mock("~/browser/BrowserSurfaceSlot", () => ({
  BrowserSurfaceSlot: (props: Record<string, unknown>) => {
    mocks.surfaceProps.push(props);
    return null;
  },
}));

// This file covers the Electron thumbnail, which is the surface that exists
// only where a guest can actually be rendered.
let electron = true;
let primaryEnvironmentId: string | null = "env-1";

vi.mock("~/env", () => ({
  get isElectron() {
    return electron;
  },
}));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => primaryEnvironmentId,
}));
vi.mock("./PreviewRemoteSurface", () => ({
  PreviewRemoteSurface: (props: Record<string, unknown>) => {
    mocks.mirrorProps.push(props);
    return null;
  },
}));
vi.mock("~/browser/previewRuntimeTabId", () => ({
  previewRuntimeTabId: () => "runtime-tab-1",
}));

vi.mock("./previewBridge", () => ({ previewBridge: null }));

vi.mock("~/previewStateStore", () => ({
  useThreadPreviewState: () => ({
    sessions: { "tab-1": { url: "http://localhost:5173/" } },
    desktopByTabId: { "tab-1": { hasWebContents: true, pictureInPicture: false } },
    serverEpoch: 1,
  }),
}));

vi.mock("~/previewMiniPlayerStore", () => ({
  selectThreadPreviewMiniPlayer: () => ({
    tabId: "tab-1",
    position: { x: 40, y: 60 },
    size: { width: 320, height: 200 },
  }),
  usePreviewMiniPlayerStore: Object.assign(
    (select: (state: unknown) => unknown) =>
      select({ byThreadKey: {}, close: mocks.close, move: vi.fn(), resize: vi.fn() }),
    {
      getState: () => ({ close: mocks.close, move: vi.fn(), resize: vi.fn() }),
    },
  ),
}));

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openBrowser: mocks.openBrowser }) },
}));

const { ThreadPreviewMiniPlayer } = await import("./ThreadPreviewMiniPlayer");

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
} as never;

function render() {
  return renderToStaticMarkup(
    <ThreadPreviewMiniPlayer threadRef={threadRef} tabId="tab-1" bottomInset={0} />,
  );
}

describe("ThreadPreviewMiniPlayer", () => {
  beforeEach(() => {
    mocks.surfaceProps.length = 0;
    mocks.mirrorProps.length = 0;
    mocks.openBrowser.mockClear();
    mocks.close.mockClear();
    electron = true;
    primaryEnvironmentId = "env-1";
  });

  it("mirrors an off-machine guest, still as a thumbnail you drag", () => {
    primaryEnvironmentId = "env-2";
    render();
    expect(mocks.surfaceProps).toHaveLength(0);
    // Same contract as the local surface it replaces: a click moves the
    // window, it does not land in the page.
    expect(mocks.mirrorProps[0]).toMatchObject({ tabId: "tab-1", interactive: false });
  });

  it("presents the guest surface non-interactively", () => {
    render();
    // Floating, this is a thumbnail you move. A click must never reach the
    // guest page; interactivity is what "Open" promotes you to.
    expect(mocks.surfaceProps).toHaveLength(1);
    expect(mocks.surfaceProps[0]?.interactive).toBe(false);
    expect(mocks.surfaceProps[0]?.audible).toBe(false);
  });

  it("does not mount a redundant surface for the same visible sidebar tab", () => {
    const html = renderToStaticMarkup(
      <ThreadPreviewMiniPlayer
        threadRef={threadRef}
        tabId="tab-1"
        bottomInset={0}
        activePanelTabId="tab-1"
      />,
    );

    expect(html).toBe("");
    expect(mocks.surfaceProps).toHaveLength(0);
  });

  it("covers the whole player with a drag surface above the guest", () => {
    const html = render();
    // Explicit layer rather than relying on the guest's `pointer-events: none`
    // letting clicks fall through, so dragging works however the guest is hosted.
    expect(html).toContain("data-preview-mini-player-drag");
  });

  it("offers a resize grip in both bottom corners", () => {
    const html = render();
    expect(html).toContain('data-testid="preview-mini-player-resize-left"');
    expect(html).toContain('data-testid="preview-mini-player-resize-right"');
    expect(html).toContain("cursor-nesw-resize");
    expect(html).toContain("cursor-nwse-resize");
  });

  it("exposes an Open affordance that promotes the preview to the right panel", () => {
    const html = render();
    expect(html).toContain('data-testid="preview-mini-player-open"');
    expect(html).toContain("Open preview in right panel");
  });

  it("keeps the pop-out and close controls reachable", () => {
    const html = render();
    expect(html).toContain("Close floating preview");
    expect(html).toContain("Pop preview into separate window");
  });
});
