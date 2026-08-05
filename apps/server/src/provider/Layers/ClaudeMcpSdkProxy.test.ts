import { assert, describe, it } from "@effect/vitest";

import { __testing } from "./ClaudeMcpSdkProxy.ts";

describe("ClaudeMcpSdkProxy", () => {
  it("marks every forwarded tool as always-load without dropping server metadata", () => {
    const result = __testing.alwaysLoadTools({
      tools: [
        {
          name: "thread_collaboration",
          description: "Coordinate related Solla chats.",
          inputSchema: {
            type: "object",
            properties: {},
          },
          _meta: {
            "solla/source": "credential-scoped-http",
          },
        },
      ],
    });

    assert.deepEqual(result.tools[0]?._meta, {
      "solla/source": "credential-scoped-http",
      "anthropic/alwaysLoad": true,
    });
  });
});
