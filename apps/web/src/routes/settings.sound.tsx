import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/sound")({
  component: lazyRouteComponent(
    () => import("../components/settings/SettingsPanels"),
    "SoundAndVoiceSettingsPanel",
  ),
});
