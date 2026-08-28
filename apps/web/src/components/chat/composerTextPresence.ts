import { useCallback, useEffect, useState } from "react";

export function useComposerTextPresence(prompt: string) {
  const [editorHasText, setEditorHasText] = useState(() => prompt.trim().length > 0);

  useEffect(() => {
    setEditorHasText(prompt.trim().length > 0);
  }, [prompt]);

  const syncEditorTextPresence = useCallback((nextPrompt: string) => {
    setEditorHasText(nextPrompt.trim().length > 0);
  }, []);

  return {
    currentEditorHasText: editorHasText || prompt.trim().length > 0,
    setEditorHasText,
    syncEditorTextPresence,
  };
}
