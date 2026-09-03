import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

export function useComposerTextPresence(
  prompt: string,
  maxChars: number = PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
) {
  const [editorHasText, setEditorHasText] = useState(() => prompt.trim().length > 0);
  // Boolean on purpose. It flips only when the prompt crosses the provider's
  // limit, so React bails out of the state update on every ordinary keystroke
  // and watching the length costs no extra renders — which matters here,
  // because the composer sits on the same main thread as the message list.
  const [editorPromptTooLong, setEditorPromptTooLong] = useState(
    () => prompt.trim().length > maxChars,
  );

  useEffect(() => {
    const trimmedLength = prompt.trim().length;
    setEditorHasText(trimmedLength > 0);
    setEditorPromptTooLong(trimmedLength > maxChars);
  }, [prompt, maxChars]);

  const syncEditorTextPresence = useCallback(
    (nextPrompt: string) => {
      const trimmedLength = nextPrompt.trim().length;
      setEditorHasText(trimmedLength > 0);
      setEditorPromptTooLong(trimmedLength > maxChars);
    },
    [maxChars],
  );

  return {
    currentEditorHasText: editorHasText || prompt.trim().length > 0,
    /** True once the prompt exceeds what the provider will validate. */
    currentEditorPromptTooLong: editorPromptTooLong || prompt.trim().length > maxChars,
    setEditorHasText,
    syncEditorTextPresence,
  };
}
