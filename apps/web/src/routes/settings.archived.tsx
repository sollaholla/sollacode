import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/archived")({
  component: lazyRouteComponent(
    () => import("../components/settings/SettingsPanels"),
    "ArchivedThreadsPanel",
  ),
});
