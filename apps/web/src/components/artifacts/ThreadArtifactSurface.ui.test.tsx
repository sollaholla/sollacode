// @vitest-environment happy-dom

import {
  EnvironmentId,
  ThreadArtifactId,
  ThreadArtifactKey,
  ThreadId,
  type ThreadArtifactDetail,
  type ThreadArtifactSummary,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

const mocks = vi.hoisted(() => ({
  archive: vi.fn(async () => ({ _tag: "Success" as const })),
  archiveToken: Symbol.for("artifact-archive-command"),
  closeSurface: vi.fn(),
  deleteArtifact: vi.fn(async () => ({ _tag: "Success" as const })),
  deleteToken: Symbol.for("artifact-delete-command"),
  detailData: null as unknown,
  detailRefresh: vi.fn(),
  detailToken: Symbol.for("artifact-detail-query"),
  fetchArtifact: vi.fn(),
  listData: null as unknown,
  listRefresh: vi.fn(),
  listToken: Symbol.for("artifact-list-query"),
  navigate: vi.fn(),
  restore: vi.fn(async () => ({ _tag: "Success" as const })),
  restoreToken: Symbol.for("artifact-restore-command"),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrl: () => null,
  useAssetUrlState: () => ({
    _tag: "Success" as const,
    url: "https://assets.test/readme.md",
  }),
}));

vi.mock("~/components/ChatMarkdown", () => ({
  default: (props: { readonly text: string }) => (
    <article data-testid="rendered-artifact-markdown">{props.text}</article>
  ),
}));

vi.mock("~/components/ui/dialog", () => ({
  Dialog: (props: { readonly open?: boolean; readonly children?: ReactNode }) =>
    props.open ? <div data-testid="delete-artifact-dialog">{props.children}</div> : null,
  DialogDescription: (props: { readonly children?: ReactNode }) => <p>{props.children}</p>,
  DialogFooter: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  DialogHeader: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  DialogPopup: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { readonly children?: ReactNode }) => <h2>{props.children}</h2>,
}));

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ closeSurface: mocks.closeSurface }),
  },
}));

vi.mock("~/state/threadArtifacts", () => ({
  threadArtifactEnvironment: {
    archive: mocks.archiveToken,
    delete: mocks.deleteToken,
    detail: () => mocks.detailToken,
    list: () => mocks.listToken,
    restore: mocks.restoreToken,
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: unknown) => {
    if (query === mocks.listToken) {
      return {
        data: mocks.listData,
        error: null,
        isPending: false,
        refresh: mocks.listRefresh,
      };
    }
    if (query === mocks.detailToken) {
      return {
        data: mocks.detailData,
        error: null,
        isPending: false,
        refresh: mocks.detailRefresh,
      };
    }
    throw new Error("Unexpected artifact query token.");
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command === mocks.archiveToken) return mocks.archive;
    if (command === mocks.restoreToken) return mocks.restore;
    if (command === mocks.deleteToken) return mocks.deleteArtifact;
    throw new Error("Unexpected artifact command token.");
  },
}));

import { ThreadArtifactSurface } from "./ThreadArtifactSurface";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;
const artifactId = ThreadArtifactId.make("artifact-1");
const revision = {
  artifactId,
  revision: 1,
  entryPath: "README.md",
  contentType: "text/markdown",
  byteLength: 32,
  fileCount: 1,
  iconSource: "generated" as const,
  createdAt: "2026-08-25T12:00:00.000Z",
};
const summary: ThreadArtifactSummary = {
  artifact: {
    artifactId,
    threadId: threadRef.threadId,
    key: ThreadArtifactKey.make("readme"),
    title: "Release notes",
    description: null,
    kind: "markdown",
    currentRevision: 1,
    archivedAt: null,
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
  },
  revision,
  entryResource: {
    _tag: "artifact-revision",
    threadId: threadRef.threadId,
    artifactId,
    revision: 1,
    path: "README.md",
  },
  iconResource: {
    _tag: "artifact-icon",
    threadId: threadRef.threadId,
    artifactId,
    revision: 1,
  },
};
const detail: ThreadArtifactDetail = {
  ...summary,
  revisions: [revision],
};
const surface: Extract<RightPanelSurface, { kind: "artifact" }> = {
  id: `artifact:${artifactId}`,
  kind: "artifact",
  resourceId: artifactId,
  revision: 1,
  title: "Release notes",
};

let container: HTMLDivElement;
let root: Root;

function buttonNamed(name: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Could not find button named ${name}.`);
  }
  return button;
}

async function renderSurface(): Promise<void> {
  await act(async () => {
    root.render(<ThreadArtifactSurface threadRef={threadRef} surface={surface} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.archive.mockClear();
  mocks.closeSurface.mockClear();
  mocks.deleteArtifact.mockClear();
  mocks.detailRefresh.mockClear();
  mocks.listRefresh.mockClear();
  mocks.navigate.mockClear();
  mocks.restore.mockClear();
  mocks.listData = { threadId: threadRef.threadId, artifacts: [summary] };
  mocks.detailData = detail;
  mocks.fetchArtifact.mockReset();
  mocks.fetchArtifact.mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode("# Rendered release notes").buffer,
  });
  vi.stubGlobal("fetch", mocks.fetchArtifact);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ThreadArtifactSurface UI", () => {
  it("renders markdown through ChatMarkdown and exposes the artifact toolbar", async () => {
    await renderSurface();

    expect(mocks.fetchArtifact).toHaveBeenCalledWith(
      "https://assets.test/readme.md",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[data-testid="rendered-artifact-markdown"]')?.textContent).toBe(
      "# Rendered release notes",
    );
    expect(buttonNamed("Link")).toBeTruthy();
    expect(buttonNamed("Archive")).toBeTruthy();
    expect(buttonNamed("Delete")).toBeTruthy();
  });

  it("confirms deletion, routes the mutation, and closes the deleted surface", async () => {
    await renderSurface();

    act(() => buttonNamed("Delete").click());
    expect(container.querySelector('[data-testid="delete-artifact-dialog"]')).not.toBeNull();

    await act(async () => {
      buttonNamed("Delete artifact").click();
      await Promise.resolve();
    });

    expect(mocks.deleteArtifact).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, artifactId },
    });
    expect(mocks.closeSurface).toHaveBeenCalledWith(threadRef, surface.id);
    expect(container.querySelector('[data-testid="delete-artifact-dialog"]')).toBeNull();
  });
});
