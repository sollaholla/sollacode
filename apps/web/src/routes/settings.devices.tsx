import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/devices")({
  component: lazyRouteComponent(
    () => import("../components/settings/DevicesSettings"),
    "DevicesSettingsPanel",
  ),
});
