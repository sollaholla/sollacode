// @vitest-environment happy-dom
import type { EditorId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { useStableEditorList } from "./useStableEditorList";

const editor = (id: string) => id as EditorId;

async function observeIdentities(
  renders: ReadonlyArray<ReadonlyArray<EditorId> | undefined>,
): Promise<ReadonlyArray<ReadonlyArray<EditorId>>> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const seen: Array<ReadonlyArray<EditorId>> = [];
  function Probe(props: { readonly editors: ReadonlyArray<EditorId> | undefined }) {
    seen.push(useStableEditorList(props.editors));
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    for (const editors of renders) {
      await act(async () => root.render(<Probe editors={editors} />));
    }
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
  return seen;
}

it("keeps one array identity while a re-emitted config carries the same editors", async () => {
  const seen = await observeIdentities([
    [editor("cursor"), editor("vscode")],
    [editor("cursor"), editor("vscode")],
    [editor("cursor"), editor("vscode")],
  ]);
  expect(seen[1]).toBe(seen[0]);
  expect(seen[2]).toBe(seen[0]);
});

it("keeps one identity for repeated renders before any config has loaded", async () => {
  const seen = await observeIdentities([undefined, undefined, undefined]);
  expect(seen[0]).toEqual([]);
  expect(seen[1]).toBe(seen[0]);
  expect(seen[2]).toBe(seen[0]);
});

it("moves to a new array when the set of editors really changes", async () => {
  const seen = await observeIdentities([[editor("cursor")], [editor("cursor"), editor("zed")]]);
  expect(seen[1]).not.toBe(seen[0]);
  expect(seen[1]).toEqual([editor("cursor"), editor("zed")]);
});
