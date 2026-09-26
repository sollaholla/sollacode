import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it } from "vite-plus/test";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { collapseSenderSideChats } from "./senderThreadNavigation";

const parent = scopeThreadRef("env" as EnvironmentId, ThreadId.make("parent"));
const sender = scopeThreadRef("env" as EnvironmentId, ThreadId.make("sender"));
beforeEach(() => useRightPanelStore.setState({ byThreadKey: {} }));

it("reveals the parent sender even when navigation stays on the same route", () => {
  useRightPanelStore.getState().openSideChat(parent, "child", "Child");
  const before = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, parent);
  collapseSenderSideChats(parent, parent);
  expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, parent)).toEqual({
    ...before,
    isOpen: false,
  });
});

it("collapses both route and destination side chats while retaining their tabs", () => {
  const store = useRightPanelStore.getState();
  store.openSideChat(parent, "child", "Child");
  store.openSideChat(sender, "other-child", "Other child");
  collapseSenderSideChats(parent, sender);
  for (const ref of [parent, sender]) {
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
    expect(state.isOpen).toBe(false);
    expect(state.surfaces).toHaveLength(1);
  }
});

it("does not hide unrelated browser panels", () => {
  useRightPanelStore.getState().openBrowser(parent, "tab");
  collapseSenderSideChats(parent, sender);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, parent).isOpen,
  ).toBe(true);
});
