import { createDeviceEnvironmentAtoms } from "@t3tools/client-runtime/state/devices";

import { connectionAtomRuntime } from "../connection/runtime";

export const deviceEnvironment = createDeviceEnvironmentAtoms(connectionAtomRuntime);
