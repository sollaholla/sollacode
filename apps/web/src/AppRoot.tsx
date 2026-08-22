import { RouterProvider } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { isElectron } from "./env";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

const ElectronBrowserHost = lazy(() =>
  import("./browser/ElectronBrowserHost").then((module) => ({
    default: module.ElectronBrowserHost,
  })),
);
const PreviewAutomationHosts = lazy(() =>
  import("./components/preview/PreviewAutomationHosts").then((module) => ({
    default: module.PreviewAutomationHosts,
  })),
);

export function DesktopRendererHosts() {
  if (!isElectron) return null;
  return (
    <Suspense fallback={null}>
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
    </Suspense>
  );
}

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <DesktopRendererHosts />
    </AppAtomRegistryProvider>
  );
}
