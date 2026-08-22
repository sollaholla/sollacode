import { createThreadArtifactEnvironmentAtoms } from "@t3tools/client-runtime/state/thread-artifacts";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadArtifactEnvironment =
  createThreadArtifactEnvironmentAtoms(connectionAtomRuntime);
