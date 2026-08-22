import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";

import { SidebarInset } from "../components/ui/sidebar";

const AgentWorkspace = lazyRouteComponent(
  () => import("../components/agents/AgentWorkspace"),
  "AgentWorkspace",
);

function EnvironmentAgentRouteView() {
  const { environmentId, agentId } = Route.useParams();
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <AgentWorkspace agentId={agentId} environmentId={EnvironmentId.make(environmentId)} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/agents/$environmentId/$agentId")({
  component: EnvironmentAgentRouteView,
});
