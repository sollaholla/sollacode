// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

/**
 * Structural guards for the task creation surfaces.
 *
 * These are source-text checks because the web tests run without a DOM. What
 * they hold in place is the shape that was explicitly asked for: task creation
 * lives in a dialog rather than a form permanently embedded above the task
 * list, and its dropdowns are the app's Select component rather than raw
 * `<select>` elements styled by hand — the two things that made the panel read
 * as unfinished next to the rest of the UI.
 */
const read = (name: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, name), "utf8");

describe("task creation surfaces", () => {
  it("keeps the creation form in a dialog, not embedded above the list", () => {
    const panel = read("AgentWorkspacePanels.tsx");
    expect(panel).toContain("CreateTaskDialog");
    // The old inline form's markers must not come back to the panel.
    expect(panel).not.toContain("generateTaskPrompt");
    expect(panel).not.toContain("<select");
  });

  it("uses the app's Select for dropdowns rather than raw selects", () => {
    const dialog = read("CreateTaskDialog.tsx");
    expect(dialog).toContain('from "~/components/ui/select"');
    expect(dialog).not.toContain("<select");
  });

  it("labels every field instead of relying on placeholders", () => {
    const dialog = read("CreateTaskDialog.tsx");
    for (const id of ["task-title", "task-prompt", "task-criteria"]) {
      expect(dialog).toContain(`htmlFor="${id}"`);
    }
  });

  it("converts a generated once-schedule into local wall time for the picker", () => {
    // datetime-local inputs read local time; handing them a UTC slice shifts
    // the run by the timezone offset, silently.
    const dialog = read("CreateTaskDialog.tsx");
    expect(dialog).toContain("getTimezoneOffset");
  });
});
