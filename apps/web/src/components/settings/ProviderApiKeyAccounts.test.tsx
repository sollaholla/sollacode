// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  ProviderInstanceId,
  type ProviderApiKeyAccountAction,
  type ProviderApiKeyAccounts,
} from "@t3tools/contracts";
import { ProviderApiKeyAccountsView } from "./ProviderApiKeyAccounts";

let root: Root;
let container: HTMLDivElement;
const instanceId = ProviderInstanceId.make("deepcode-work");
const accounts: ProviderApiKeyAccounts = {
  activeAccountId: "personal",
  accounts: [
    {
      id: "personal",
      name: "Personal",
      baseUrl: "https://api.deepseek.com",
      credentialId: "private-a",
      keySuffix: "1234",
    },
    {
      id: "work",
      name: "Work",
      baseUrl: "https://api.deepseek.com",
      credentialId: "private-b",
      keySuffix: "5678",
    },
  ],
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function button(name: string) {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
function setInput(label: string, value: string) {
  const input = [...container.querySelectorAll("label")]
    .find((item) => item.textContent?.includes(label))
    ?.querySelector("input");
  if (!input) throw new Error(`Missing input ${label}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("switches named accounts without a logout flow and requires confirmation to delete", async () => {
  const onAction = vi
    .fn<(action: ProviderApiKeyAccountAction) => Promise<boolean>>()
    .mockResolvedValue(true);
  await act(async () =>
    root.render(
      <ProviderApiKeyAccountsView
        instanceId={instanceId}
        accounts={accounts}
        pending={false}
        error={null}
        onAction={onAction}
      />,
    ),
  );
  expect(container.textContent).toContain("•••• 1234");
  expect(container.textContent).not.toContain("private-a");
  await act(async () => button("Use this key").click());
  expect(onAction).toHaveBeenLastCalledWith({ action: "select", instanceId, id: "work" });
  act(() => button("Remove Personal").click());
  expect(onAction).toHaveBeenCalledTimes(1);
  await act(async () => button("Remove key").click());
  expect(onAction).toHaveBeenLastCalledWith({ action: "remove", instanceId, id: "personal" });
});

it("submits a new key only on Save and clears its password field after success", async () => {
  const onAction = vi
    .fn<(action: ProviderApiKeyAccountAction) => Promise<boolean>>()
    .mockResolvedValue(true);
  await act(async () =>
    root.render(
      <ProviderApiKeyAccountsView
        instanceId={instanceId}
        accounts={undefined}
        pending={false}
        error={null}
        onAction={onAction}
      />,
    ),
  );
  act(() => button("Add key").click());
  act(() => {
    setInput("Account name", "Work");
    setInput("API key", "sk-fixture-new");
  });
  expect(container.querySelector('input[type="password"]')).not.toBeNull();
  expect(onAction).not.toHaveBeenCalled();
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(onAction).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "save",
      instanceId,
      name: "Work",
      apiKey: "sk-fixture-new",
      baseUrl: "https://api.deepseek.com",
      activate: true,
    }),
  );
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(container.innerHTML).not.toContain("sk-fixture-new");
});

it("edits a name while preserving the server-owned key", async () => {
  const onAction = vi
    .fn<(action: ProviderApiKeyAccountAction) => Promise<boolean>>()
    .mockResolvedValue(true);
  await act(async () =>
    root.render(
      <ProviderApiKeyAccountsView
        instanceId={instanceId}
        accounts={accounts}
        pending={false}
        error={null}
        onAction={onAction}
      />,
    ),
  );
  act(() => button("Edit Personal").click());
  expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
  act(() => setInput("Account name", "Home"));
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(onAction).toHaveBeenCalledWith({
    action: "save",
    instanceId,
    id: "personal",
    name: "Home",
    baseUrl: "https://api.deepseek.com",
    activate: true,
  });
});
