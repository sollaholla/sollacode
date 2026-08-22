import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/diagnostics")({
  component: lazyRouteComponent(
    () => import("../components/settings/DiagnosticsSettings"),
    "DiagnosticsSettingsPanel",
  ),
});
