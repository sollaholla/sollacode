import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/keybindings")({
  component: lazyRouteComponent(
    () => import("../components/settings/KeybindingsSettings"),
    "KeybindingsSettingsPanel",
  ),
});
