import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/connections")({
  component: lazyRouteComponent(
    () => import("../components/settings/ConnectionsSettings"),
    "ConnectionsSettings",
  ),
});
