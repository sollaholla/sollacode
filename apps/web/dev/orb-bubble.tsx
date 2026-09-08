import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopOrchestratorBubbleState } from "@t3tools/contracts";
import { OrchestratorBubbleApp } from "../src/orchestrator/OrchestratorBubbleApp";
import { usePreviewVoiceLevel } from "./usePreviewVoiceLevel";

let receive: ((state: DesktopOrchestratorBubbleState) => void) | undefined;
let toggle: (() => void) | undefined;
// Only this standalone review page gets a simulated bridge. No host or microphone calls.
Object.defineProperty(window, "desktopBridge", {
  value: {
    orchestratorBubble: {
      onState: (listener: typeof receive) => {
        receive = listener;
        return () => {
          receive = undefined;
        };
      },
      setInteractive: async () => undefined,
      beginDrag: async () => undefined,
      move: async () => undefined,
      dragEnd: async () => undefined,
      open: async () => {
        document.body.dataset.threadOpened = "true";
      },
      toggleVoice: async () => toggle?.(),
    },
  },
});
function BubblePreview() {
  const [live, setLive] = useState(true);
  const level = usePreviewVoiceLevel(live);
  useEffect(() => {
    toggle = () => setLive((value) => !value);
    return () => {
      toggle = undefined;
    };
  }, []);
  useEffect(() => {
    receive?.({ status: live ? "listening" : "idle", micLevel: level, assistantLevel: 0 });
  }, [live, level]);
  return <OrchestratorBubbleApp />;
}
createRoot(document.getElementById("root")!).render(<BubblePreview />);
