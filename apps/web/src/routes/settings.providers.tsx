import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/providers")({
  component: lazyRouteComponent(
    () => import("../components/settings/SettingsPanels"),
    "ProviderSettingsPanel",
  ),
});
