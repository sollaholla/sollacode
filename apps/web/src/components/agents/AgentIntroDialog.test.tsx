// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const hooks = vi.hoisted(() => ({
  create: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => hooks.create }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: hooks.navigate }) }));

import type { EnvironmentId } from "@t3tools/contracts";

import { AgentIntroDialog } from "./AgentIntroDialog";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
  });
};

const buttonNamed = (text: string) =>
  [...document.querySelectorAll("button")].find((button) => button.textContent?.includes(text));

it("walks from meeting the cast to a named, created agent", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  hooks.create.mockResolvedValue({
    _tag: "Success",
    value: { vmAgentId: "agent-1", name: "Lantern", avatarColor: 3 },
  });
  const onOpenChange = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AgentIntroDialog
        open
        onOpenChange={onOpenChange}
        environmentId={"env-1" as EnvironmentId}
        onBuildWithAi={() => {}}
      />,
    );
  });

  expect(document.body.textContent).toContain("Meet your agents");
  expect(document.querySelectorAll("[data-testid=agent-intro-cast] img")).toHaveLength(7);
  await click(buttonNamed("Pick your first agent"));

  const characters = document.querySelectorAll("[data-testid=agent-intro-character]");
  expect(characters).toHaveLength(11);
  await click(characters[3]);
  expect(characters[3]?.getAttribute("aria-checked")).toBe("true");
  await click(buttonNamed("Choose Lantern"));

  const name = document.querySelector<HTMLInputElement>("#agent-intro-name");
  expect(name?.value).toBe("Lantern");
  expect(buttonNamed("Bring Lantern to life")?.hasAttribute("disabled")).toBe(true);
  await click(buttonNamed("Research scout"));
  await click(buttonNamed("Bring Lantern to life"));

  expect(hooks.create).toHaveBeenCalledWith({
    environmentId: "env-1",
    input: expect.objectContaining({ name: "Lantern", avatarColor: 3 }),
  });
  expect(document.body.textContent).toContain("Lantern is ready");
  await click(buttonNamed("Say hello to Lantern"));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(hooks.navigate).toHaveBeenCalledWith({
    to: "/agents/$environmentId/$agentId",
    params: { environmentId: "env-1", agentId: "agent-1" },
  });
  await act(async () => root.unmount());
});
