import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import { IntentionalShutdownOverlay } from "./components/IntentionalShutdownOverlay";

const OrchestratorBubbleApp = lazy(() =>
  import("./orchestrator/OrchestratorBubbleApp").then((module) => ({
    default: module.OrchestratorBubbleApp,
  })),
);

// The floating voice orb is a second desktop window that must not boot the
// full app (router, environment connections, its own voice session) — it is a
// pure mirror fed over the desktop bridge. Branching on the hash here keeps it
// out of the route tree entirely.
const isOrchestratorBubbleWindow =
  isElectron && window.location.hash.startsWith("#/orchestrator-bubble");

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const app = isOrchestratorBubbleWindow ? (
  <Suspense fallback={null}>
    <OrchestratorBubbleApp />
  </Suspense>
) : (
  <>
    <AppRoot router={getRouter(history)} />
    <IntentionalShutdownOverlay />
  </>
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{app}</React.StrictMode>,
);
