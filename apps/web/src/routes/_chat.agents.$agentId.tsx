import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";

function LegacyAgentRouteRedirect() {
  const agentId = Route.useParams({ select: (params) => params.agentId });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();

  useEffect(() => {
    if (primaryEnvironmentId === null) return;
    void navigate({
      to: "/agents/$environmentId/$agentId",
      params: { environmentId: primaryEnvironmentId, agentId },
      replace: true,
    });
  }, [agentId, navigate, primaryEnvironmentId]);

  return (
    <main className="flex h-svh min-w-0 items-center justify-center overflow-hidden bg-background px-4 text-sm text-muted-foreground md:h-dvh">
      Opening agent…
    </main>
  );
}

export const Route = createFileRoute("/_chat/agents/$agentId")({
  component: LegacyAgentRouteRedirect,
});
