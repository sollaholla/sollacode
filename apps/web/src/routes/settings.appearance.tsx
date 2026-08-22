import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/appearance")({
  component: lazyRouteComponent(
    () => import("../components/settings/SettingsPanels"),
    "AppearanceSettingsPanel",
  ),
});
