import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/credentials")({
  component: lazyRouteComponent(
    () => import("../components/settings/CredentialsSettings"),
    "CredentialsSettingsPanel",
  ),
});
