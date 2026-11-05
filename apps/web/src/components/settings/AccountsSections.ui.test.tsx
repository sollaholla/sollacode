// @vitest-environment happy-dom
import type { PreviewBrowserProfile, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { UseInMenu } from "./AccountsSections";

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

const agentProfile = {
  kind: "agent",
  rootThreadId: "thread-scout" as ThreadId,
} as PreviewBrowserProfile;

it("opens with its group labels instead of crashing Settings", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <UseInMenu
          projects={[{ key: "project:acme", label: "Acme", profile: agentProfile }]}
          agents={[{ key: "agent:scout", label: "Scout", profile: agentProfile }]}
          disabled={false}
          defaultOpen
          onPick={() => {}}
        />,
      ),
    );
    const text = document.body.textContent;
    for (const expected of ["Projects", "Acme", "Agents", "Scout"]) {
      expect(text).toContain(expected);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
