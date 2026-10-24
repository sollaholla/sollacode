import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/projects")({
  component: lazyRouteComponent(
    () => import("../components/settings/ProjectsSettings"),
    "ProjectsSettingsPanel",
  ),
});
