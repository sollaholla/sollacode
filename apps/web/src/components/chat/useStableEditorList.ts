import type { EditorId } from "@t3tools/contracts";
import { useMemo } from "react";

const NO_AVAILABLE_EDITORS: ReadonlyArray<EditorId> = [];

/**
 * The same editor list, by content, and a stable empty list while none is known.
 *
 * It arrives from the server-config stream, which re-emits (and re-decodes
 * every array) on each provider or usage update, and it feeds the open-in-editor
 * callback that ChatMarkdown's components map depends on. An unpinned list
 * gave that map a new identity each time the config ticked, and react-markdown
 * remounted every link and icon in the transcript, which read as flashing.
 * `?? []` at the call site had the same effect on every render while the
 * config was still loading.
 */
export function useStableEditorList(
  editors: ReadonlyArray<EditorId> | undefined,
): ReadonlyArray<EditorId> {
  const list = editors ?? NO_AVAILABLE_EDITORS;
  const key = list.join("\u0000");
  // The key is the content; the array identity is exactly what must not matter.
  // Keep this directive even though the linter calls it unused: the React
  // Compiler reads it as "the deps are deliberate" and otherwise adds `list`
  // to them, which defeats the pin.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => list, [key]);
}
