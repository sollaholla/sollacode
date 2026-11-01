import { createFileRoute, redirect } from "@tanstack/react-router";

import {
  SettingsRouteLayout,
  SettingsRoutePending,
} from "../components/settings/SettingsRouteLayout";

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: SettingsRouteLayout,
  pendingComponent: SettingsRoutePending,
  pendingMs: 0,
  pendingMinMs: 0,
});
