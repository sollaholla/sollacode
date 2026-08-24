import { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  legacyProjectCwdPreferenceKey,
  markThreadUnread,
  markThreadVisited,
  parsePersistedState,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  persistState,
  reorderProjects,
  resolveProjectExpanded,
  setDefaultAdvertisedEndpointKey,
  setProjectExpanded,
  setThreadChangedFilesExpanded,
  setThreadPanelExpanded,
  THREAD_PANEL_AGENTS_TASKS,
  THREAD_PANEL_ARTIFACTS,
  type UiState,
} from "./uiStateStore";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    threadPanelExpandedById: {},
    defaultAdvertisedEndpointKey: null,
    showProviderUsageBar: false,
    settledShelfExpanded: false,
    agentsSectionExpanded: true,
    threadsSectionExpanded: true,
    ...overrides,
  };
}

describe("uiStateStore pure functions", () => {
  it("stores server timestamps without moving visit state backwards", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState();
    const visited = markThreadVisited(initialState, threadId, "2026-02-25T12:30:00.700Z");

    expect(visited.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:30:00.700Z");
    expect(markThreadVisited(visited, threadId, "2026-02-25T12:30:00.000Z")).toBe(visited);
    expect(markThreadVisited(visited, threadId, "not-a-date")).toBe(visited);
  });

  it("marks a completed thread unread using the server completion timestamp", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, "2026-02-25T12:30:00.000Z");

    expect(next.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:29:59.999Z");
    expect(markThreadUnread(next, threadId, null)).toBe(next);
  });

  it("resolves project expansion from logical, physical, and legacy preference keys", () => {
    const physicalKey = "environment:/repo/project";
    const legacyKey = legacyProjectCwdPreferenceKey("/repo/project");

    expect(resolveProjectExpanded({ logical: false, [physicalKey]: true }, ["logical"])).toBe(
      false,
    );
    expect(resolveProjectExpanded({ [physicalKey]: false }, ["new-logical", physicalKey])).toBe(
      false,
    );
    expect(resolveProjectExpanded({ [legacyKey]: false }, ["new-logical", legacyKey])).toBe(false);
    expect(resolveProjectExpanded({}, ["new-logical"])).toBe(true);
  });

  it("sets expansion for every stable key belonging to a logical project", () => {
    const initialState = makeUiState();
    const keys = ["logical", "environment-a:/repo", "environment-b:/repo"];

    const next = setProjectExpanded(initialState, keys, false);

    expect(next.projectExpandedById).toEqual({
      logical: false,
      "environment-a:/repo": false,
      "environment-b:/repo": false,
    });
    expect(setProjectExpanded(next, keys, false)).toBe(next);
  });

  it("reorders from the current atom-derived project order", () => {
    const project1 = ProjectId.make("project-1");
    const project2 = ProjectId.make("project-2");
    const project3 = ProjectId.make("project-3");
    const currentOrder = [project1, project2, project3];

    const next = reorderProjects(makeUiState(), currentOrder, [project1], [project3]);

    expect(next.projectOrder).toEqual([project2, project3, project1]);
  });

  it("moves grouped project members together", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const currentOrder = [keyALocal, keyARemote, keyB, keyC];

    const next = reorderProjects(makeUiState(), currentOrder, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote]);
  });

  it("does not reorder missing or identical groups", () => {
    const currentOrder = ["env-local:proj-a", "env-local:proj-b"];
    const state = makeUiState();

    expect(reorderProjects(state, currentOrder, ["env-local:missing"], ["env-local:proj-b"])).toBe(
      state,
    );
    expect(reorderProjects(state, currentOrder, ["env-local:proj-a"], ["env-local:proj-a"])).toBe(
      state,
    );
  });

  it("stores explicit changed-file expansion choices", () => {
    const threadId = ThreadId.make("thread-1");
    const collapsed = setThreadChangedFilesExpanded(makeUiState(), threadId, "turn-1", false);

    expect(collapsed.threadChangedFilesExpandedById).toEqual({
      [threadId]: {
        "turn-1": false,
      },
    });
    expect(
      setThreadChangedFilesExpanded(collapsed, threadId, "turn-1", true)
        .threadChangedFilesExpandedById,
    ).toEqual({
      [threadId]: {
        "turn-1": true,
      },
    });
  });

  it("stores the endpoint preference by stable key", () => {
    const next = setDefaultAdvertisedEndpointKey(makeUiState(), "desktop-core:lan:http");

    expect(next.defaultAdvertisedEndpointKey).toBe("desktop-core:lan:http");
    expect(setDefaultAdvertisedEndpointKey(next, "desktop-core:lan:http")).toBe(next);
    expect(setDefaultAdvertisedEndpointKey(next, "")).toMatchObject({
      defaultAdvertisedEndpointKey: null,
    });
  });
});

describe("parsePersistedState", () => {
  it("defaults the Sidebar v2 settled shelf collapsed and preserves an explicit choice", () => {
    expect(parsePersistedState({}).settledShelfExpanded).toBe(false);
    expect(parsePersistedState({ settledShelfExpanded: true }).settledShelfExpanded).toBe(true);
  });

  it("defaults the Agents and Threads sections open and preserves an explicit collapse", () => {
    // Opposite polarity from the settled shelf above: these read `!== false`, so
    // absent means "never collapsed" rather than "collapsed". Upgrading from a
    // build without these keys must not fold up both sidebar sections, and only
    // a literal `false` — not any stray truthy-ish value — may collapse one.
    expect(parsePersistedState({})).toMatchObject({
      agentsSectionExpanded: true,
      threadsSectionExpanded: true,
    });
    expect(
      parsePersistedState({ agentsSectionExpanded: false, threadsSectionExpanded: false }),
    ).toMatchObject({ agentsSectionExpanded: false, threadsSectionExpanded: false });
    expect(
      parsePersistedState({ agentsSectionExpanded: "false" as unknown as boolean }),
    ).toMatchObject({ agentsSectionExpanded: true });
  });

  it("collapses the Agents and Threads sections independently", () => {
    expect(parsePersistedState({ agentsSectionExpanded: false })).toMatchObject({
      agentsSectionExpanded: false,
      threadsSectionExpanded: true,
    });
    expect(parsePersistedState({ threadsSectionExpanded: false })).toMatchObject({
      agentsSectionExpanded: true,
      threadsSectionExpanded: false,
    });
  });
  it("hydrates raw UI-owned state without server entities", () => {
    const parsed = parsePersistedState({
      projectExpandedById: {
        logical: false,
        invalid: "no" as unknown as boolean,
      },
      projectOrder: ["physical-b", "", "physical-a", "physical-b"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
        invalid: "not-a-date",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      showProviderUsageBar: true,
      settledShelfExpanded: false,
      threadChangedFilesExpansionVersion: 1,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });

    expect(parsed).toEqual({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      showProviderUsageBar: true,
      settledShelfExpanded: false,
      agentsSectionExpanded: true,
      threadsSectionExpanded: true,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
      threadPanelExpandedById: {},
    });
  });

  it("ignores changed-file expansion values saved with legacy folder semantics", () => {
    const parsed = parsePersistedState({
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
        },
      },
    });

    expect(parsed.threadChangedFilesExpandedById).toEqual({});
  });

  it("defaults the provider usage bar off and hydrates only an explicit true", () => {
    expect(parsePersistedState({}).showProviderUsageBar).toBe(false);
    expect(parsePersistedState({ showProviderUsageBar: true }).showProviderUsageBar).toBe(true);
    expect(
      parsePersistedState({ showProviderUsageBar: "yes" as unknown as boolean })
        .showProviderUsageBar,
    ).toBe(false);
  });

  it("migrates legacy CWD project preferences into local alias keys", () => {
    const parsed = parsePersistedState({
      collapsedProjectCwds: ["/repo/b"],
      expandedProjectCwds: ["/repo/a"],
      projectOrderCwds: ["/repo/b", "/repo/a"],
    });
    const projectAKey = legacyProjectCwdPreferenceKey("/repo/a");
    const projectBKey = legacyProjectCwdPreferenceKey("/repo/b");

    expect(parsed.projectOrder).toEqual([projectBKey, projectAKey]);
    expect(resolveProjectExpanded(parsed.projectExpandedById, [projectAKey])).toBe(true);
    expect(resolveProjectExpanded(parsed.projectExpandedById, [projectBKey])).toBe(false);
    expect(resolveProjectExpanded(parsed.projectExpandedById, ["unknown"])).toBe(true);
  });

  it("preserves legacy expanded-only semantics for one-way migration", () => {
    const parsed = parsePersistedState({
      expandedProjectCwds: ["/repo/a"],
    });

    expect(
      resolveProjectExpanded(parsed.projectExpandedById, [
        legacyProjectCwdPreferenceKey("/repo/a"),
      ]),
    ).toBe(true);
    expect(
      resolveProjectExpanded(parsed.projectExpandedById, [
        legacyProjectCwdPreferenceKey("/repo/b"),
      ]),
    ).toBe(false);
  });
});

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => {
      store.clear();
    },
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe("uiStateStore persistence", () => {
  let localStorageStub: Storage;

  beforeEach(() => {
    localStorageStub = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage: localStorageStub });
    vi.stubGlobal("localStorage", localStorageStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists raw UI preferences including thread visit markers", () => {
    const state = makeUiState({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
      threadPanelExpandedById: {},
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
    });

    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted).toEqual({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      showProviderUsageBar: false,
      settledShelfExpanded: false,
      agentsSectionExpanded: true,
      threadsSectionExpanded: true,
      threadChangedFilesExpansionVersion: 1,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
      threadPanelExpandedById: {},
    });
    expect(parsePersistedState(persisted)).toEqual({
      ...state,
    });
  });

  it("round-trips a collapsed sidebar section through storage", () => {
    persistState(makeUiState({ agentsSectionExpanded: false }));

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;

    expect(parsePersistedState(persisted)).toMatchObject({
      agentsSectionExpanded: false,
      threadsSectionExpanded: true,
    });
  });

  it("drops the temporary expanded-only migration fallback when rewriting state", () => {
    const migrated = parsePersistedState({
      expandedProjectCwds: ["/repo/a"],
    });

    persistState(migrated);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(resolveProjectExpanded(persisted.projectExpandedById ?? {}, ["unknown"])).toBe(true);
  });
});

describe("setThreadPanelExpanded", () => {
  it("remembers each shelf per thread and defaults to collapsed", () => {
    const state = makeUiState();
    // Nothing recorded yet: both shelves read as collapsed.
    expect(state.threadPanelExpandedById["env:thread-a"]?.[THREAD_PANEL_ARTIFACTS]).toBeUndefined();

    const opened = setThreadPanelExpanded(state, "env:thread-a", THREAD_PANEL_ARTIFACTS, true);
    expect(opened.threadPanelExpandedById["env:thread-a"]?.[THREAD_PANEL_ARTIFACTS]).toBe(true);
    // A sibling thread is unaffected — the whole point of keying by thread.
    expect(opened.threadPanelExpandedById["env:thread-b"]).toBeUndefined();

    const bothPanels = setThreadPanelExpanded(
      opened,
      "env:thread-a",
      THREAD_PANEL_AGENTS_TASKS,
      true,
    );
    expect(bothPanels.threadPanelExpandedById["env:thread-a"]).toEqual({
      [THREAD_PANEL_ARTIFACTS]: true,
      [THREAD_PANEL_AGENTS_TASKS]: true,
    });

    const closed = setThreadPanelExpanded(
      bothPanels,
      "env:thread-a",
      THREAD_PANEL_ARTIFACTS,
      false,
    );
    expect(closed.threadPanelExpandedById["env:thread-a"]?.[THREAD_PANEL_ARTIFACTS]).toBe(false);
    expect(closed.threadPanelExpandedById["env:thread-a"]?.[THREAD_PANEL_AGENTS_TASKS]).toBe(true);
  });

  it("returns the same state when nothing changes, so no needless rerender", () => {
    const state = setThreadPanelExpanded(makeUiState(), "env:t", THREAD_PANEL_ARTIFACTS, true);
    expect(setThreadPanelExpanded(state, "env:t", THREAD_PANEL_ARTIFACTS, true)).toBe(state);
  });

  it("hydrates a remembered shelf, and drops malformed entries", () => {
    // Persisting is the whole feature: the shelf has to stay how it was left
    // across a reload, not just across a remount.
    const rehydrated = parsePersistedState({
      threadPanelExpandedById: {
        "env:t": { [THREAD_PANEL_ARTIFACTS]: true, [THREAD_PANEL_AGENTS_TASKS]: false },
        "env:bad": { [THREAD_PANEL_ARTIFACTS]: "yes" as unknown as boolean },
      },
    } as PersistedUiState);

    expect(rehydrated.threadPanelExpandedById["env:t"]).toEqual({
      [THREAD_PANEL_ARTIFACTS]: true,
      [THREAD_PANEL_AGENTS_TASKS]: false,
    });
    // A non-boolean cannot decide whether a panel is open, so the whole entry goes.
    expect(rehydrated.threadPanelExpandedById["env:bad"]).toBeUndefined();
  });
});
