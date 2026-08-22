/**
 * Browser-side entry. Exposes a single imperative hook the renderer drives:
 * `window.__motion.setFrame(n)` renders that exact frame synchronously and
 * resolves once React has committed, so a screenshot taken afterwards is
 * guaranteed to show frame n and never a half-applied one.
 */
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { COMPOSITIONS } from "../compositions";
import { FrameProvider } from "./index";
import "../theme/tokens.css";

declare global {
  interface Window {
    __motion: {
      readonly setFrame: (frame: number) => void;
      readonly ready: () => Promise<void>;
    };
  }
}

const params = new URLSearchParams(window.location.search);
const id = params.get("composition");
const composition = COMPOSITIONS.find((entry) => entry.id === id);
if (!composition) {
  throw new Error(`Unknown composition: ${id ?? "(none)"}`);
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");

document.documentElement.style.width = `${composition.width}px`;
document.documentElement.style.height = `${composition.height}px`;

const root: Root = createRoot(container);
const Component = composition.component;

window.__motion = {
  setFrame: (frame: number) => {
    // flushSync so the commit lands before this call returns; the renderer
    // screenshots immediately afterwards.
    flushSync(() => {
      root.render(
        <StrictMode>
          <FrameProvider
            value={{
              frame,
              fps: composition.fps,
              width: composition.width,
              height: composition.height,
              durationInFrames: composition.durationInFrames,
            }}
          >
            <Component />
          </FrameProvider>
        </StrictMode>,
      );
    });
  },
  ready: async () => {
    // Fonts must be resolved before the first screenshot or early frames render
    // in a fallback face and the clip visibly reflows partway through.
    await document.fonts.ready;
  },
};
