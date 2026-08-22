import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/orchestrator")({
  component: lazyRouteComponent(
    () => import("../components/settings/OrchestratorSettings"),
    "OrchestratorSettingsPanel",
  ),
});
