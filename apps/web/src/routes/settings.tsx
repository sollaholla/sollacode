import { createFileRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }

    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: lazyRouteComponent(
    () => import("../components/settings/SettingsRouteLayout"),
    "SettingsRouteLayout",
  ),
});
