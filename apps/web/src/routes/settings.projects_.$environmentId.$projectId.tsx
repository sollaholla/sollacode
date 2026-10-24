import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/projects_/$environmentId/$projectId")({
  component: lazyRouteComponent(
    () => import("../components/settings/ProjectsSettings"),
    "ProjectDetailSettingsPanel",
  ),
});
