// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { TerminalMobileKeyBar } from "./TerminalMobileKeyBar";
import { bracketedPaste, TERMINAL_MOBILE_KEYS } from "./mobileKeys";

function render(props: {
  readonly onSend: (data: string) => void;
  readonly onReadClipboard: () => Promise<string>;
}): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    createRoot(host).render(
      <TerminalMobileKeyBar onReadClipboard={props.onReadClipboard} onSend={props.onSend} />,
    );
  });
  return host;
}

function pressKey(host: HTMLElement, id: string): void {
  const button = host.querySelector<HTMLButtonElement>(`[data-terminal-mobile-key="${id}"]`);
  expect(button, `no key button for ${id}`).not.toBeNull();
  act(() => {
    button?.click();
  });
}

describe("TerminalMobileKeyBar", () => {
  it("sends the byte a physical key would produce", () => {
    const onSend = vi.fn();
    const host = render({ onSend, onReadClipboard: async () => "" });

    pressKey(host, "ctrl-c");
    expect(onSend).toHaveBeenCalledWith("\u0003");

    pressKey(host, "escape");
    expect(onSend).toHaveBeenCalledWith("\u001B");

    pressKey(host, "tab");
    expect(onSend).toHaveBeenCalledWith("\u0009");

    pressKey(host, "up");
    expect(onSend).toHaveBeenCalledWith("\u001B[A");
  });

  it("wraps a paste so a multi-line clipboard does not execute line by line", async () => {
    const onSend = vi.fn();
    const host = render({
      onSend,
      onReadClipboard: async () => "echo one\necho two",
    });

    pressKey(host, "paste");
    await act(async () => {
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith(bracketedPaste("echo one\necho two"));
    expect(onSend.mock.calls[0]?.[0]).toContain("echo one\necho two");
  });

  it("does nothing when the clipboard is empty or refused", async () => {
    const onSend = vi.fn();
    const host = render({
      onSend,
      onReadClipboard: () => Promise.reject(new Error("denied")),
    });

    pressKey(host, "paste");
    await act(async () => {
      await Promise.resolve();
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("offers every key a phone keyboard cannot send", () => {
    const ids = TERMINAL_MOBILE_KEYS.map((key) => key.id);
    // Control-C is the one the user asked for by name; the rest are the other
    // keys a shell session is unusable without.
    expect(ids).toContain("ctrl-c");
    expect(ids).toContain("escape");
    expect(ids).toContain("tab");
    expect(ids).toContain("paste");
    expect(ids).toEqual([...new Set(ids)]);
  });

  it("keeps the terminal focused so the keyboard does not collapse", () => {
    const onSend = vi.fn();
    const host = render({ onSend, onReadClipboard: async () => "" });
    const button = host.querySelector<HTMLButtonElement>('[data-terminal-mobile-key="ctrl-c"]');
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => {
      button?.dispatchEvent(mouseDown);
    });
    expect(mouseDown.defaultPrevented).toBe(true);
  });
});
