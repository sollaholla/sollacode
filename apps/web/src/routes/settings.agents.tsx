import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/agents")({
  component: lazyRouteComponent(
    () => import("../components/settings/SettingsPanels"),
    "AgentsSettingsPanel",
  ),
});
