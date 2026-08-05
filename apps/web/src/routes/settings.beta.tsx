import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The Beta section is retired: every setting that lived here graduated into
 * the ordinary panels (thread list under Appearance, Token Optimizer under
 * General). The route stays so existing links and any pinned window state
 * still land somewhere sensible instead of a blank page.
 */
export const Route = createFileRoute("/settings/beta")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/appearance", replace: true });
  },
});
