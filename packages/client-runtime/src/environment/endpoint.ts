export * from "@t3tools/shared/advertisedEndpoint";

/**
 * An environment's path prefix, without a trailing slash: empty for one served
 * at the root, `/api/relay/<id>` for one reached through another host's relay.
 */
export const environmentBasePath = (httpBaseUrl: string): string =>
  new URL(httpBaseUrl).pathname.replace(/\/+$/u, "");

/** `pathname` on the environment, kept under its path prefix. */
export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = `${environmentBasePath(httpBaseUrl)}${pathname}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

/** Matches the host's relay route (`apps/server/src/relay/relayRoute.ts`). */
const RELAY_ROUTE_PREFIX = "/api/relay";

/** Where an environment behind `viaHttpBaseUrl`'s relay answers HTTP. */
export const relayedEnvironmentHttpBaseUrl = (viaHttpBaseUrl: string, environmentId: string) =>
  environmentEndpointUrl(
    viaHttpBaseUrl,
    `${RELAY_ROUTE_PREFIX}/${encodeURIComponent(environmentId)}`,
  );

/** That environment's websocket, through the same relay. */
export const relayedEnvironmentWsUrl = (viaHttpBaseUrl: string, environmentId: string) => {
  const url = new URL(
    environmentEndpointUrl(
      viaHttpBaseUrl,
      `${RELAY_ROUTE_PREFIX}/${encodeURIComponent(environmentId)}/ws`,
    ),
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};
