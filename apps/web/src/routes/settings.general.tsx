import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

import { SettingsPanelPending } from "../components/settings/SettingsRouteLayout";

export const Route = createFileRoute("/settings/general")({
  pendingComponent: SettingsPanelPending,
  pendingMs: 0,
  pendingMinMs: 0,
  component: lazyRouteComponent(
    () => import("../components/settings/SettingsPanels"),
    "GeneralSettingsPanel",
  ),
});
