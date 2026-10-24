import type { Terminal } from "@xterm/xterm";
import { emptyTerminalDictationState, resolveTerminalDictationInput } from "./dictationInput";

/** Keep literal key events out of the touch IME's textarea reconciliation. */
export function subscribeTerminalKeyboardInput(
  terminal: Pick<Terminal, "onKey" | "onData" | "textarea">,
  usesTouchKeyboard: boolean,
  onData: (data: string) => void,
) {
  let state = emptyTerminalDictationState;
  let keyPayload: string | null = null;
  // xterm emits onKey immediately before onData for a normal keydown/keypress.
  // Its textarea can still contain the last IME word at that point. Comparing
  // that unchanged word would silently discard the space and every later key.
  const keys = terminal.onKey(({ key }) => {
    keyPayload = key;
  });
  const data = terminal.onData((payload) => {
    const fromKey = keyPayload === payload;
    keyPayload = null;
    const textareaValue = terminal.textarea?.value ?? "";
    if (!usesTouchKeyboard || fromKey) {
      state = { forwarded: textareaValue };
      onData(payload);
      return;
    }
    const resolved = resolveTerminalDictationInput({ payload, textareaValue, state });
    state = resolved.state;
    if (resolved.payload.length > 0) onData(resolved.payload);
  });
  return {
    reset() {
      state = emptyTerminalDictationState;
      keyPayload = null;
    },
    dispose() {
      keys.dispose();
      data.dispose();
    },
  };
}
