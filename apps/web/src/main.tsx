import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./index.css";

import { APP_VERSION } from "./branding";
import { isElectron } from "./env";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { installDynamicImportRecoveryListeners } from "./lib/dynamicImportRecoveryListeners";
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

// A release replaces every hashed chunk, so an already-open client 404s on its
// next lazy import. Install this before anything can be imported lazily: the
// router's error boundary only sees route loads, and these are the failures
// that reach no boundary at all.
installDynamicImportRecoveryListeners({
  appVersion: APP_VERSION,
  target: window,
  getStorage: () => window.sessionStorage,
  location: window.location,
  now: () => Date.now(),
  desktopBridgeAvailable: () => window.desktopBridge !== undefined,
});

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
