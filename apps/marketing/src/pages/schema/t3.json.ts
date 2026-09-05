import type { APIRoute } from "astro";

import { buildT3ProjectFileJsonSchema } from "@t3tools/shared/t3ProjectFile";

// Rendered at build time under /schema/t3.json. The compatibility filename
// remains t3.json; this fork does not publish to the upstream t3.codes domain.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildT3ProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
