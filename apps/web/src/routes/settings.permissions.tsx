import { createFileRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/permissions")({
  beforeLoad: () => {
    if (window.desktopBridge?.permissions === undefined) {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: lazyRouteComponent(
    () => import("../components/desktop/DesktopPermissions"),
    "DesktopPermissionsSettingsPanel",
  ),
});
