import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

/**
 * One agent call: where call notifications and the phone app's call screen
 * land. Full screen, outside the chat layout like the orchestrator's routes;
 * `?embedded=1` is the phone app hosting it.
 */
export const Route = createFileRoute("/call/$environmentId/$callId")({
  component: lazyRouteComponent(
    () => import("../components/agentCall/AgentCallRoute"),
    "AgentCallRoute",
  ),
});
