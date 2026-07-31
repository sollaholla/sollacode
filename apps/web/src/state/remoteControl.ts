import { createRemoteControlEnvironmentAtoms } from "@t3tools/client-runtime/state/remote-control";

import { connectionAtomRuntime } from "../connection/runtime";

export const remoteControlEnvironment = createRemoteControlEnvironmentAtoms(connectionAtomRuntime);
