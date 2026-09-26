import { decideWithJev } from "./client.ts";
import { JevToolkit } from "./tools.ts";

export const JevToolkitHandlersLive = JevToolkit.toLayer({
  jev_decide: (input) => decideWithJev(input),
});
