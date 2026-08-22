import { createVmAgentEnvironmentAtoms } from "@t3tools/client-runtime/state/vmAgents";

import { connectionAtomRuntime } from "../connection/runtime";

export const vmAgentEnvironment = createVmAgentEnvironmentAtoms(connectionAtomRuntime);
