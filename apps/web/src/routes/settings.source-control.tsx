import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/source-control")({
  component: lazyRouteComponent(
    () => import("../components/settings/SourceControlSettings"),
    "SourceControlSettingsPanel",
  ),
});
