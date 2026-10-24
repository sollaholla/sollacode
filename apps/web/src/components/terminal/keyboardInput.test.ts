// @vitest-environment happy-dom
import { Terminal } from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { subscribeTerminalKeyboardInput } from "./keyboardInput";

const disposables: Array<() => void> = [];
afterEach(() => {
  disposables
    .splice(0)
    .toReversed()
    .forEach((dispose) => dispose());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(touch = true) {
  const mount = document.createElement("div");
  document.body.append(mount);
  const terminal = new Terminal({ allowProposedApi: true });
  terminal.open(mount);
  const write = vi.fn<(data: string) => void>();
  const input = subscribeTerminalKeyboardInput(terminal, touch, write);
  disposables.push(
    () => mount.remove(),
    () => terminal.dispose(),
    () => input.dispose(),
  );
  const textarea = terminal.textarea!;
  const key = (value: string, keyCode = value.toUpperCase().charCodeAt(0)) => {
    const down = new KeyboardEvent("keydown", {
      key: value,
      keyCode,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(down);
    if (!down.defaultPrevented) {
      textarea.dispatchEvent(
        new KeyboardEvent("keypress", {
          key: value,
          keyCode,
          charCode: value.charCodeAt(0),
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    textarea.dispatchEvent(new KeyboardEvent("keyup", { key: value, keyCode, bubbles: true }));
  };
  return { terminal, textarea, write, key, input };
}

it("forwards the space and following keys when the touch textarea retains an earlier word", async () => {
  vi.useFakeTimers();
  const { textarea, write, key } = setup();
  // Real xterm composition-helper event flow, followed by ordinary key events.
  textarea.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Unidentified", keyCode: 229, bubbles: true }),
  );
  textarea.value = "fly";
  await vi.advanceTimersByTimeAsync(0);
  key(" ", 32);
  for (const c of "auth login") key(c);
  expect(write.mock.calls.map(([data]) => data).join("")).toBe("fly auth login");
});

it("retains dictation corrections after normal keys and does not resend the old word", () => {
  const { terminal, textarea, write, key } = setup();
  textarea.value = "echo";
  terminal.input("echo", true);
  key(" ", 32);
  textarea.value = "echohello";
  terminal.input("hello", true);
  textarea.value = "echoHello there";
  terminal.input("echoHello there", true);
  expect(write.mock.calls.map(([data]) => data)).toEqual([
    "echo",
    " ",
    "hello",
    "\x7f".repeat(5) + "Hello there",
  ]);
});

it("passes hardware keyboard and control input through even with a retained textarea", () => {
  const { terminal, textarea, write, key } = setup(false);
  textarea.value = "stale";
  for (const c of "fly auth login") key(c);
  terminal.input("\x1b[A", true);
  expect(write.mock.calls.map(([data]) => data).join("")).toBe("fly auth login\x1b[A");
});

it("keeps typing after a soft-keyboard space remains in the textarea", () => {
  const { terminal, textarea, write, key } = setup();
  terminal.input("fly", true);
  textarea.value = " ";
  terminal.input(" ", true);
  for (const c of "auth login") key(c);
  expect(write.mock.calls.map(([data]) => data).join("")).toBe("fly auth login");
});

it("forwards backspace and Enter without replaying the retained touch buffer", () => {
  const { terminal, textarea, write, key } = setup();
  textarea.value = "fly";
  terminal.input("fly", true);
  key("Backspace", 8);
  key("y");
  key("Enter", 13);
  expect(write.mock.calls.map(([data]) => data)).toEqual(["fly", "\x7f", "y", "\r"]);
  expect(textarea.value).toBe("");
});
