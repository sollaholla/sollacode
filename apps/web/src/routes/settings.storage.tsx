import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/storage")({
  component: lazyRouteComponent(
    () => import("../components/settings/SettingsPanels"),
    "StorageSettingsPanel",
  ),
});
