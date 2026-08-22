import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedTerminalUiStateStoreState,
  projectRemoteTerminalGroups,
  selectThreadTerminalUiState,
  terminalGroupsSyncKey,
  useTerminalUiStateStore,
} from "./terminalUiStateStore";
import { DEFAULT_THREAD_TERMINAL_ID } from "./types";

const THREAD_ID = ThreadId.make("thread-1");
const THREAD_REF = scopeThreadRef("environment-a" as never, THREAD_ID);
const OTHER_THREAD_REF = scopeThreadRef("environment-b" as never, THREAD_ID);

describe("terminalUiStateStore actions", () => {
  beforeEach(() => {
    useTerminalUiStateStore.persist.clearStorage();
    useTerminalUiStateStore.setState({
      terminalUiStateByThreadKey: {},
      suppressedTerminalIdsByThreadKey: {},
      pendingOpenTerminalIdsByThreadKey: {},
    });
  });

  it("returns an empty default terminal UI state for unknown threads", () => {
    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState).toEqual({
      mainSurface: "chat",
      terminalFullscreen: false,
      terminalHeight: 280,
      sidebarWidth: 144,
      terminalIds: [],
      activeTerminalId: "",
      terminalGroups: [],
      activeTerminalGroupId: "",
    });
  });

  it("renames groups and clears the name when renamed to blank", () => {
    const store = useTerminalUiStateStore.getState();
    store.setMainSurface(THREAD_REF, "terminal");
    store.splitTerminal(THREAD_REF, "terminal-2");

    const groupId = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    ).terminalGroups[0]!.id;

    store.renameTerminalGroup(THREAD_REF, groupId, "  Build agents  ");
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalGroups[0]!.name,
    ).toBe("Build agents");

    store.renameTerminalGroup(THREAD_REF, groupId, "   ");
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalGroups[0]!.name,
    ).toBeUndefined();
  });

  it("clamps the sidebar width into its bounds", () => {
    const store = useTerminalUiStateStore.getState();
    store.setMainSurface(THREAD_REF, "terminal");

    store.setTerminalSidebarWidth(THREAD_REF, 300);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).sidebarWidth,
    ).toBe(300);

    store.setTerminalSidebarWidth(THREAD_REF, 10);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).sidebarWidth,
    ).toBe(120);

    store.setTerminalSidebarWidth(THREAD_REF, 5000);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).sidebarWidth,
    ).toBe(480);
  });

  it("opens and splits terminals into the active group", () => {
    const store = useTerminalUiStateStore.getState();
    store.setMainSurface(THREAD_REF, "terminal");
    store.splitTerminal(THREAD_REF, "terminal-2");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID, "terminal-2"]);
    expect(terminalUiState.activeTerminalId).toBe("terminal-2");
    expect(terminalUiState.terminalGroups).toEqual([
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "terminal-2"],
        layout: {
          kind: "split",
          direction: "horizontal",
          children: [
            { kind: "terminal", terminalId: DEFAULT_THREAD_TERMINAL_ID },
            { kind: "terminal", terminalId: "terminal-2" },
          ],
        },
      },
    ]);
  });

  it("stacks vertically split terminals in the active group", () => {
    const store = useTerminalUiStateStore.getState();
    store.setMainSurface(THREAD_REF, "terminal");
    store.splitTerminalVertical(THREAD_REF, "terminal-2");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalGroups).toEqual([
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "terminal-2"],
        layout: {
          kind: "split",
          direction: "vertical",
          children: [
            { kind: "terminal", terminalId: DEFAULT_THREAD_TERMINAL_ID },
            { kind: "terminal", terminalId: "terminal-2" },
          ],
        },
      },
    ]);
  });

  it("materializes the default terminal when entering an empty terminal mode", () => {
    useTerminalUiStateStore.getState().setMainSurface(THREAD_REF, "terminal");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState).toEqual({
      mainSurface: "terminal",
      terminalFullscreen: false,
      terminalHeight: 280,
      sidebarWidth: 144,
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
      terminalGroups: [
        {
          id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
          terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
        },
      ],
      activeTerminalGroupId: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
    });
  });

  it("caps splits at four terminals per group", () => {
    const store = useTerminalUiStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.splitTerminal(THREAD_REF, "terminal-4");
    store.splitTerminal(THREAD_REF, "terminal-5");
    store.splitTerminal(THREAD_REF, "terminal-6");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual([
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
    ]);
    expect(terminalUiState.terminalGroups).toEqual([
      {
        id: "group-terminal-2",
        terminalIds: ["terminal-2", "terminal-3", "terminal-4", "terminal-5"],
        layout: {
          kind: "split",
          direction: "horizontal",
          children: [
            { kind: "terminal", terminalId: "terminal-2" },
            { kind: "terminal", terminalId: "terminal-3" },
            { kind: "terminal", terminalId: "terminal-4" },
            { kind: "terminal", terminalId: "terminal-5" },
          ],
        },
      },
    ]);
  });

  it("creates new terminals in a separate group", () => {
    useTerminalUiStateStore.getState().newTerminal(THREAD_REF, "terminal-2");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual(["terminal-2"]);
    expect(terminalUiState.activeTerminalId).toBe("terminal-2");
    expect(terminalUiState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("ensures unknown server terminals are registered, opened, and activated", () => {
    const store = useTerminalUiStateStore.getState();
    store.ensureTerminal(THREAD_REF, "setup-setup", { active: true });

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual(["setup-setup"]);
    expect(terminalUiState.activeTerminalId).toBe("setup-setup");
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-setup-setup", terminalIds: ["setup-setup"] },
    ]);
  });

  it("keeps state isolated per environment when raw thread ids collide", () => {
    const store = useTerminalUiStateStore.getState();
    store.setMainSurface(THREAD_REF, "terminal");
    store.newTerminal(OTHER_THREAD_REF, "env-b-terminal");

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).mainSurface,
    ).toBe("terminal");
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        OTHER_THREAD_REF,
      ).terminalIds,
    ).toEqual(["env-b-terminal"]);
  });

  it("drops persisted entries whose thread keys are not valid scoped keys", () => {
    const migrated = migratePersistedTerminalUiStateStoreState(
      {
        terminalStateByThreadKey: {
          [scopedThreadKey(THREAD_REF)]: {
            terminalHeight: 320,
            terminalIds: ["term-1"],
            activeTerminalId: "term-1",
            terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
            activeTerminalGroupId: "group-term-1",
          },
          "legacy-thread-id": {
            terminalHeight: 320,
            terminalIds: ["term-1"],
            activeTerminalId: "term-1",
            terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
            activeTerminalGroupId: "group-term-1",
          },
        },
        suppressedTerminalIdsByThreadKey: {
          [scopedThreadKey(THREAD_REF)]: ["term-closed", "term-closed", "  "],
          "legacy-thread-id": ["term-legacy"],
        },
      },
      2,
    );

    expect(migrated).toEqual({
      terminalUiStateByThreadKey: {
        [scopedThreadKey(THREAD_REF)]: {
          mainSurface: "chat",
          terminalFullscreen: false,
          terminalHeight: 320,
          sidebarWidth: 144,
          terminalIds: ["term-1"],
          activeTerminalId: "term-1",
          terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
          activeTerminalGroupId: "group-term-1",
        },
      },
      suppressedTerminalIdsByThreadKey: {
        [scopedThreadKey(THREAD_REF)]: ["term-closed"],
      },
    });
  });

  it("persists close intent but not optimistic opens", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-1");
    store.closeTerminal(THREAD_REF, "term-1");
    store.newTerminal(THREAD_REF, "term-2");

    const partialize = useTerminalUiStateStore.persist.getOptions().partialize;
    expect(partialize?.(useTerminalUiStateStore.getState())).toEqual(
      expect.objectContaining({
        suppressedTerminalIdsByThreadKey: {
          [scopedThreadKey(THREAD_REF)]: ["term-1"],
        },
      }),
    );
    expect(partialize?.(useTerminalUiStateStore.getState())).not.toHaveProperty(
      "pendingOpenTerminalIdsByThreadKey",
    );
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "terminal-only");
    store.closeTerminal(THREAD_REF, "terminal-only");

    expect(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey[scopedThreadKey(THREAD_REF)],
    ).toBeUndefined();
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual([]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.closeTerminal(THREAD_REF, "terminal-3");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.activeTerminalId).toBe("terminal-2");
    expect(terminalUiState.terminalIds).toEqual(["terminal-2"]);
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("keeps a locally opened terminal until the server confirms it, then defers to the server", () => {
    const store = useTerminalUiStateStore.getState();
    store.setMainSurface(THREAD_REF, "terminal");
    // The server list lags the just-opened default terminal: keep it, adopt
    // the rest.
    store.reconcileTerminalIds(THREAD_REF, ["term-a", "term-b"]);

    let terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID, "term-a", "term-b"]);

    // Once the server confirms the id, its later absence means the terminal
    // was closed on another machine, so it must drop here too.
    store.reconcileTerminalIds(THREAD_REF, [DEFAULT_THREAD_TERMINAL_ID, "term-a", "term-b"]);
    store.reconcileTerminalIds(THREAD_REF, ["term-a", "term-b"]);

    terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual(["term-a", "term-b"]);
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-term-a", terminalIds: ["term-a"] },
      { id: "group-term-b", terminalIds: ["term-b"] },
    ]);
  });

  it("rolls back a failed optimistic terminal without suppressing a future server session", () => {
    const store = useTerminalUiStateStore.getState();
    store.setMainSurface(THREAD_REF, "terminal");
    store.rejectPendingTerminalOpen(THREAD_REF, DEFAULT_THREAD_TERMINAL_ID);

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ),
    ).toEqual(expect.objectContaining({ terminalIds: [] }));
    expect(useTerminalUiStateStore.getState().suppressedTerminalIdsByThreadKey).toEqual({});

    store.reconcileTerminalIds(THREAD_REF, [DEFAULT_THREAD_TERMINAL_ID]);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual([DEFAULT_THREAD_TERMINAL_ID]);
  });

  it("does not roll back a terminal after the server confirms it", () => {
    const store = useTerminalUiStateStore.getState();
    store.setMainSurface(THREAD_REF, "terminal");
    store.reconcileTerminalIds(THREAD_REF, [DEFAULT_THREAD_TERMINAL_ID]);
    store.rejectPendingTerminalOpen(THREAD_REF, DEFAULT_THREAD_TERMINAL_ID);

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual([DEFAULT_THREAD_TERMINAL_ID]);
  });

  it("removes only the failed split while preserving a confirmed terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.setMainSurface(THREAD_REF, "terminal");
    store.reconcileTerminalIds(THREAD_REF, [DEFAULT_THREAD_TERMINAL_ID]);
    store.splitTerminal(THREAD_REF, "term-2");

    store.rejectPendingTerminalOpen(THREAD_REF, "term-2");

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ),
    ).toEqual(
      expect.objectContaining({
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
        activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
      }),
    );
  });

  it("rolls back an initial terminal-mode open without leaving a disconnected pane", () => {
    const store = useTerminalUiStateStore.getState();
    store.setMainSurface(THREAD_REF, "terminal");

    store.rejectPendingTerminalOpen(THREAD_REF, DEFAULT_THREAD_TERMINAL_ID);

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ),
    ).toEqual(
      expect.objectContaining({
        mainSurface: "terminal",
        terminalIds: [],
        activeTerminalId: "",
      }),
    );
  });

  it("drops the group of a terminal closed on another machine", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-1");
    store.newTerminal(THREAD_REF, "term-2");
    store.newTerminal(THREAD_REF, "term-3");
    store.reconcileTerminalIds(THREAD_REF, ["term-1", "term-2", "term-3"]);

    store.reconcileTerminalIds(THREAD_REF, ["term-1", "term-2"]);

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual(["term-1", "term-2"]);
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-term-1", terminalIds: ["term-1"] },
      { id: "group-term-2", terminalIds: ["term-2"] },
    ]);
  });

  it("preserves local terminal order when the server list only differs in order", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-10");
    store.newTerminal(THREAD_REF, "term-2");
    store.reconcileTerminalIds(THREAD_REF, ["term-2", "term-10"]);

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["term-10", "term-2"]);
  });

  it("does not import a closed panel terminal from stale metadata", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-2");
    store.closeTerminal(THREAD_REF, "term-1");

    store.reconcileTerminalIds(THREAD_REF, ["term-1", "term-2"]);

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["term-2"]);

    store.newTerminal(THREAD_REF, "term-1");
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["term-2", "term-1"]);
  });

  it("keeps close intent until an authoritative server list confirms removal", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-1");
    store.reconcileTerminalIds(THREAD_REF, ["term-1"]);
    store.closeTerminal(THREAD_REF, "term-1");

    store.reconcileTerminalIds(THREAD_REF, ["term-1"]);
    expect(useTerminalUiStateStore.getState().suppressedTerminalIdsByThreadKey).toEqual({
      [scopedThreadKey(THREAD_REF)]: ["term-1"],
    });
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual([]);

    store.reconcileTerminalIds(THREAD_REF, []);
    expect(useTerminalUiStateStore.getState().suppressedTerminalIdsByThreadKey).toEqual({});
  });

  it("resets terminal fullscreen when switching back to chat", () => {
    const store = useTerminalUiStateStore.getState();
    store.setMainSurface(THREAD_REF, "terminal");
    store.setMainSurface(THREAD_REF, "terminal");

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ),
    ).toEqual(
      expect.objectContaining({
        mainSurface: "terminal",
      }),
    );

    store.setMainSurface(THREAD_REF, "chat");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.mainSurface).toBe("chat");
    expect(terminalUiState.terminalFullscreen).toBe(false);
  });

  it("launches a terminal when entering terminal mode with none", () => {
    const store = useTerminalUiStateStore.getState();
    store.setMainSurface(THREAD_REF, "terminal");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.mainSurface).toBe("terminal");
    expect(terminalUiState.terminalFullscreen).toBe(false);
    expect(terminalUiState.terminalIds.length).toBeGreaterThan(0);
  });

  it("returns a stable selector identity for persisted state missing terminalFullscreen", () => {
    const persisted = {
      mainSurface: "terminal" as const,
      terminalHeight: 280,
      sidebarWidth: 144,
      terminalIds: ["term-1"],
      activeTerminalId: "term-1",
      terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
      activeTerminalGroupId: "group-term-1",
    };
    const byThreadKey = {
      [scopedThreadKey(THREAD_REF)]: persisted as never,
    };

    const first = selectThreadTerminalUiState(byThreadKey, THREAD_REF);
    const second = selectThreadTerminalUiState(byThreadKey, THREAD_REF);

    expect(first).toBe(second);
    expect(first.terminalFullscreen).toBe(false);
    expect(first.mainSurface).toBe("terminal");
  });

  it("keeps fullscreen off until it is explicitly enabled, and leaving terminal mode clears it", () => {
    const store = useTerminalUiStateStore.getState();
    store.setMainSurface(THREAD_REF, "terminal");
    store.setTerminalFullscreen(THREAD_REF, true);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalFullscreen,
    ).toBe(true);

    store.setMainSurface(THREAD_REF, "chat");
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalFullscreen,
    ).toBe(false);
  });

  it("keeps the terminal main surface when the last terminal closes", () => {
    const store = useTerminalUiStateStore.getState();
    store.setMainSurface(THREAD_REF, "terminal");
    store.newTerminal(THREAD_REF, "term-1");
    store.closeTerminal(THREAD_REF, "term-1");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.mainSurface).toBe("terminal");
    expect(terminalUiState.terminalIds).toEqual([]);
  });

  it("splits only the active pane, nesting a sub-split inside its cell", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-1");
    store.splitTerminal(THREAD_REF, "term-2");
    // term-2 is now active; a vertical split must nest inside term-2's cell
    // instead of reorienting term-1.
    store.splitTerminalVertical(THREAD_REF, "term-3");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalGroups[0]?.layout).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [
        { kind: "terminal", terminalId: "term-1" },
        {
          kind: "split",
          direction: "vertical",
          children: [
            { kind: "terminal", terminalId: "term-2" },
            { kind: "terminal", terminalId: "term-3" },
          ],
        },
      ],
    });
  });

  it("stores dragged split sizes and drops them when the pane count changes", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-1");
    store.splitTerminal(THREAD_REF, "term-2");

    const groupId = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    ).activeTerminalGroupId;
    store.setGroupSplitSizes(THREAD_REF, groupId, [], [3, 1]);

    const sized = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(sized.terminalGroups[0]?.layout).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [
        { kind: "terminal", terminalId: "term-1" },
        { kind: "terminal", terminalId: "term-2" },
      ],
      sizes: [0.75, 0.25],
    });

    store.closeTerminal(THREAD_REF, "term-2");
    const resized = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(resized.terminalGroups[0]?.layout).toBeUndefined();
  });

  it("moves a dragged pane: center drops swap, edge drops split the target", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-1");
    store.splitTerminal(THREAD_REF, "term-2");

    const groupId = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    ).activeTerminalGroupId;
    store.moveTerminalInGroup(THREAD_REF, groupId, "term-1", "term-2", "center");

    const swapped = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(swapped.terminalGroups[0]?.terminalIds).toEqual(["term-2", "term-1"]);

    store.moveTerminalInGroup(THREAD_REF, groupId, "term-2", "term-1", "bottom");
    const split = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(split.terminalGroups[0]?.layout).toEqual({
      kind: "split",
      direction: "vertical",
      children: [
        { kind: "terminal", terminalId: "term-1" },
        { kind: "terminal", terminalId: "term-2" },
      ],
    });
  });

  it("reorders terminals inside a group from the sidebar list", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-1");
    store.splitTerminal(THREAD_REF, "term-2");
    store.splitTerminal(THREAD_REF, "term-3");

    const groupId = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    ).activeTerminalGroupId;

    store.moveTerminalToGroup(THREAD_REF, "term-3", groupId, {
      type: "before",
      terminalId: "term-1",
    });

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalGroups[0]?.terminalIds,
    ).toEqual(["term-3", "term-1", "term-2"]);
  });

  it("moves a terminal between groups and drops an emptied source group", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-1");
    store.splitTerminal(THREAD_REF, "term-2");
    store.newTerminal(THREAD_REF, "term-3");

    const groups = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    ).terminalGroups;
    expect(groups).toHaveLength(2);
    const firstGroupId = groups[0]!.id;
    const secondGroupId = groups[1]!.id;

    store.moveTerminalToGroup(THREAD_REF, "term-3", firstGroupId, {
      type: "after",
      terminalId: "term-1",
    });

    const moved = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(moved.terminalGroups).toHaveLength(1);
    expect(moved.terminalGroups[0]?.id).toBe(firstGroupId);
    expect(moved.terminalGroups[0]?.terminalIds).toEqual(["term-1", "term-3", "term-2"]);
    expect(moved.activeTerminalId).toBe("term-3");
    expect(moved.activeTerminalGroupId).toBe(firstGroupId);
    expect(secondGroupId).not.toBe(firstGroupId);
  });

  it("does not move a terminal into a group that is already full", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-1");
    store.splitTerminal(THREAD_REF, "term-2");
    store.splitTerminal(THREAD_REF, "term-3");
    store.splitTerminal(THREAD_REF, "term-4");
    store.newTerminal(THREAD_REF, "term-5");

    const groups = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    ).terminalGroups;
    const fullGroupId = groups.find((group) => group.terminalIds.length === 4)!.id;

    store.moveTerminalToGroup(THREAD_REF, "term-5", fullGroupId, { type: "end" });

    const after = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(after.terminalGroups).toHaveLength(2);
    expect(
      after.terminalGroups.find((group) => group.id === fullGroupId)?.terminalIds,
    ).toHaveLength(4);
    expect(after.terminalGroups.some((group) => group.terminalIds.includes("term-5"))).toBe(true);
  });

  it("reorders groups from the sidebar list", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-1");
    store.newTerminal(THREAD_REF, "term-2");
    store.newTerminal(THREAD_REF, "term-3");

    const before = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    ).terminalGroups;
    expect(before.map((group) => group.terminalIds[0])).toEqual(["term-1", "term-2", "term-3"]);

    store.reorderTerminalGroups(THREAD_REF, before[2]!.id, {
      type: "before",
      groupId: before[0]!.id,
    });

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalGroups.map((group) => group.terminalIds[0]),
    ).toEqual(["term-3", "term-1", "term-2"]);
  });

  it("is a no-op when clearing terminal UI state for a thread with no state", () => {
    const store = useTerminalUiStateStore.getState();
    const before = useTerminalUiStateStore.getState();

    store.clearTerminalUiState(THREAD_REF);

    expect(useTerminalUiStateStore.getState()).toBe(before);
  });

  it("adopts a remote layout document, projected onto the local terminal ids", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-1");
    store.newTerminal(THREAD_REF, "term-2");
    store.newTerminal(THREAD_REF, "term-4");

    // The document merges term-1 and term-4 into a split, names the group,
    // and references term-9 which this client does not know about.
    store.applyRemoteTerminalLayout(THREAD_REF, [
      {
        id: "group-main",
        name: "Main",
        terminalIds: ["term-1", "term-4", "term-9"],
        layout: {
          kind: "split",
          direction: "horizontal",
          children: [
            { kind: "terminal", terminalId: "term-1" },
            { kind: "terminal", terminalId: "term-4" },
            { kind: "terminal", terminalId: "term-9" },
          ],
        },
      },
    ]);

    const after = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    const mainGroup = after.terminalGroups.find((group) => group.id === "group-main");
    expect(mainGroup?.name).toBe("Main");
    // Unknown ids drop out of the projection; local-only ids keep a group.
    expect(mainGroup?.terminalIds).toEqual(["term-1", "term-4"]);
    expect(after.terminalGroups.some((group) => group.terminalIds.includes("term-2"))).toBe(true);
    expect(after.terminalIds).toEqual(["term-1", "term-2", "term-4"]);
  });

  it("projection matches the adopted state so no push-back is needed", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-1");
    store.newTerminal(THREAD_REF, "term-2");

    const remoteGroups = [{ id: "group-solo", terminalIds: ["term-1", "term-9"] }];
    store.applyRemoteTerminalLayout(THREAD_REF, remoteGroups);

    const after = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    // Two clients with different id sets must not ping-pong pushes: the
    // adopted state and the re-projection of the same document agree.
    expect(terminalGroupsSyncKey(after.terminalGroups)).toBe(
      terminalGroupsSyncKey(projectRemoteTerminalGroups(remoteGroups, after.terminalIds)),
    );
  });
});
