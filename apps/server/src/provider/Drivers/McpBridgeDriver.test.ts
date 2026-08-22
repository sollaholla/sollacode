import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeMcpBridgeProcessEnvironment,
  SOLLA_PROVIDER_INSTANCE_ID_ENV,
} from "./McpBridgeDriver.ts";

describe("McpBridgeDriver process environment", () => {
  it("stamps the owning provider instance after merging user environment", () => {
    const instanceId = ProviderInstanceId.make("external_bridge_two");
    const environment = makeMcpBridgeProcessEnvironment(
      [
        { name: "BRIDGE_OPTION", value: "enabled", sensitive: false },
        {
          name: SOLLA_PROVIDER_INSTANCE_ID_ENV,
          value: "spoofed-instance",
          sensitive: false,
        },
      ],
      instanceId,
    );

    expect(environment.BRIDGE_OPTION).toBe("enabled");
    expect(environment[SOLLA_PROVIDER_INSTANCE_ID_ENV]).toBe(instanceId);
  });
});
