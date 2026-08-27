// @vitest-environment happy-dom

import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  checkWorkspaceRoot: vi.fn(() => Symbol.for("project-workspace-root-query")),
  refresh: vi.fn(),
  updateProject: vi.fn(async () => ({ _tag: "Success" as const })),
  updateToken: Symbol.for("project-update-command"),
}));

vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    checkWorkspaceRoot: mocks.checkWorkspaceRoot,
    update: mocks.updateToken,
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { exists: false, workspaceRoot: "/workspace/Old Project" },
    error: null,
    isPending: false,
    refresh: mocks.refresh,
  }),
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command !== mocks.updateToken) throw new Error("Unexpected project command token.");
    return mocks.updateProject;
  },
}));

import { ProjectFolderMissingBanner } from "./ProjectFolderMissingBanner";

const environmentId = EnvironmentId.make("environment-1");
const project: EnvironmentProject = {
  environmentId,
  id: ProjectId.make("project-1"),
  title: "Old Project",
  workspaceRoot: "/workspace/Old Project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-25T12:00:00.000Z",
  updatedAt: "2026-08-25T12:00:00.000Z",
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.checkWorkspaceRoot.mockClear();
  mocks.refresh.mockClear();
  mocks.updateProject.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ProjectFolderMissingBanner", () => {
  it("re-points the project and renames it after the selected folder", async () => {
    await act(async () => {
      root.render(<ProjectFolderMissingBanner environmentId={environmentId} project={project} />);
    });

    expect(mocks.checkWorkspaceRoot).toHaveBeenCalledWith({
      environmentId,
      input: { projectId: project.id },
    });
    expect(container.textContent).toContain("Project folder not found");
    expect(container.textContent).toContain("/workspace/Old Project");

    const input = container.querySelector('input[aria-label="New project folder path"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing folder path input.");
    expect(input.value).toBe("/workspace/Old Project");

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setValue) throw new Error("Missing native input value setter.");
    await act(async () => {
      setValue.call(input, "  /workspace/Renamed Project  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    mocks.refresh.mockClear();
    await act(async () => {
      buttonNamed("Use this folder").click();
      await Promise.resolve();
    });

    expect(mocks.updateProject).toHaveBeenCalledWith({
      environmentId,
      input: {
        projectId: project.id,
        workspaceRoot: "/workspace/Renamed Project",
        title: "Renamed Project",
      },
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
