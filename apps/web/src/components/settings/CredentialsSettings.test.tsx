// @vitest-environment happy-dom
import type { DesktopPreviewBridge, PreviewCredentialSummary } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const confirmInApp = vi.hoisted(() => vi.fn<(message: string) => Promise<boolean>>());
vi.mock("../ui/appConfirm", () => ({ confirmInApp }));

import { CredentialsSettingsView } from "./CredentialsSettings";

type CredentialsBridge = DesktopPreviewBridge["credentials"];

// happy-dom has no Element.getAnimations, and the dialog's ScrollArea calls it
// from a timeout after the test ends. Module scope so it outlives teardown.
if (typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
}

const github: PreviewCredentialSummary = {
  id: "cred-github",
  label: "Work GitHub",
  origin: "https://github.com",
  username: "me@example.com",
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  confirmInApp.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function fakeBridge(initial: readonly PreviewCredentialSummary[]) {
  return {
    list: vi.fn<CredentialsBridge["list"]>().mockResolvedValue(initial),
    save: vi.fn<CredentialsBridge["save"]>(async (input) => ({
      id: input.id ?? "cred-new",
      label: input.label,
      origin: input.origin,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.username ? { username: input.username } : {}),
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T01:00:00.000Z",
    })),
    remove: vi.fn<CredentialsBridge["remove"]>().mockResolvedValue(undefined),
    listForTab: vi.fn<CredentialsBridge["listForTab"]>().mockResolvedValue([]),
    fill: vi.fn<CredentialsBridge["fill"]>(),
  } satisfies CredentialsBridge;
}

// The editor is a portalled dialog, so it is found on the document, not the host.
function button(name: string) {
  const found = [...document.body.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}

// Exact, or up to a parenthetical: the Type choices' labels also start with "Password".
function field(label: string) {
  const labelled = [...document.body.querySelectorAll("label")].find(
    (item) => item.textContent === label || item.textContent?.startsWith(`${label} (`),
  );
  const input =
    labelled?.querySelector("input") ??
    (labelled?.htmlFor ? document.getElementById(labelled.htmlFor) : null);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input ${label}`);
  return input;
}

function type(label: string, value: string) {
  const input = field(label);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function chooseKind(label: string) {
  const choice = [...document.body.querySelectorAll("label")].find((item) =>
    item.textContent?.startsWith(label),
  );
  const radio = choice?.querySelector<HTMLElement>('[role="radio"]');
  if (!radio) throw new Error(`Missing type ${label}`);
  radio.click();
}

async function submitEditor() {
  await act(async () =>
    document.body
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

it("adds a login with its password and lists it without the password", async () => {
  const bridge = fakeBridge([]);
  await act(async () => root.render(<CredentialsSettingsView bridge={bridge} />));
  expect(container.textContent).toContain("No saved credentials");

  await act(async () => button("Add credential").click());
  act(() => {
    type("Label", "Work GitHub");
    type("Website", "github.com");
    type("Username or email", "me@example.com");
    type("Password", "hunter2");
  });
  await submitEditor();

  expect(bridge.save).toHaveBeenCalledWith({
    label: "Work GitHub",
    origin: "https://github.com",
    kind: "password",
    username: "me@example.com",
    secret: "hunter2",
  });
  expect(container.textContent).toContain("Work GitHub");
  expect(container.textContent).toContain("me@example.com · https://github.com");
  expect(document.body.innerHTML).not.toContain("hunter2");
});

it("edits a login without ever sending its password back", async () => {
  const bridge = fakeBridge([github]);
  await act(async () => root.render(<CredentialsSettingsView bridge={bridge} />));

  await act(async () => button("Edit Work GitHub").click());
  expect(field("Password").value).toBe("");
  expect(field("Label").value).toBe("Work GitHub");
  act(() => type("Label", "Home GitHub"));
  await submitEditor();

  expect(bridge.save).toHaveBeenCalledWith({
    id: "cred-github",
    label: "Home GitHub",
    origin: "https://github.com",
    kind: "password",
    username: "me@example.com",
  });
  expect(container.textContent).toContain("Home GitHub");
  expect(container.textContent).not.toContain("Work GitHub");
});

it("adds a PIN with no username and marks it in the list", async () => {
  const bridge = fakeBridge([]);
  await act(async () => root.render(<CredentialsSettingsView bridge={bridge} />));

  await act(async () => button("Add credential").click());
  await act(async () => chooseKind("PIN or code"));
  // A PIN has no username, so the form stops asking for one.
  expect(() => field("Username or email")).toThrow();
  act(() => {
    type("Label", "Rent PIN");
    type("Website", "pay.example.com");
    type("PIN or code", "4821");
  });
  await submitEditor();

  expect(bridge.save).toHaveBeenCalledWith({
    label: "Rent PIN",
    origin: "https://pay.example.com",
    kind: "code",
    secret: "4821",
  });
  expect(container.textContent).toContain("PIN or code · https://pay.example.com");
  expect(document.body.innerHTML).not.toContain("4821");
});

it("deletes only after the in-app confirmation", async () => {
  const bridge = fakeBridge([github]);
  await act(async () => root.render(<CredentialsSettingsView bridge={bridge} />));

  confirmInApp.mockResolvedValueOnce(false);
  await act(async () => button("Delete Work GitHub").click());
  expect(bridge.remove).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Work GitHub");

  confirmInApp.mockResolvedValueOnce(true);
  await act(async () => button("Delete Work GitHub").click());
  expect(bridge.remove).toHaveBeenCalledWith("cred-github");
  expect(container.textContent).toContain("No saved credentials");
});

it("says the passwords could not be reached instead of claiming there are none", async () => {
  // A phone or browser reaches the vault through the desktop app on the
  // environment's machine; when that desktop is closed the list fails.
  const bridge = fakeBridge([github]);
  bridge.list.mockRejectedValueOnce(
    new Error(
      "Saved passwords are kept by the Solla Code desktop app on the computer running this environment, and it isn't connected. Open the desktop app there, then try again.",
    ),
  );
  await act(async () => root.render(<CredentialsSettingsView bridge={bridge} />));

  expect(container.textContent).toContain("Couldn't load saved credentials");
  expect(container.textContent).toContain("isn't connected");
  expect(container.textContent).not.toContain("No saved credentials");
  expect(container.textContent).not.toContain("Add credential");

  await act(async () => button("Try again").click());
  expect(bridge.list).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Work GitHub");
  expect(container.textContent).not.toContain("Couldn't load");
});

it("waits for a connection before offering anything", async () => {
  await act(async () => root.render(<CredentialsSettingsView bridge={undefined} />));
  expect(container.textContent).toContain("Loading saved credentials");
  expect(container.querySelector("button")).toBeNull();
});
