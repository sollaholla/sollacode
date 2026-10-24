import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

/**
 * The Live Inspector, every thread's work as it happens. Full screen like the
 * orchestrator's own route; `?embedded=1` is the phone app hosting it, whose
 * native header closes it.
 */
export const Route = createFileRoute("/orchestrator_/live")({
  component: lazyRouteComponent(
    () => import("../components/orchestrator/LiveInspector"),
    "LiveInspectorRoute",
  ),
});
