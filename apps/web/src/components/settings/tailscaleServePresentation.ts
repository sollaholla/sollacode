import type { DesktopServerExposureState } from "@t3tools/contracts";

export interface TailscaleServePresentation {
  readonly label: string;
  readonly description: string;
  readonly isError: boolean;
  readonly canRetry: boolean;
}

export function presentTailscaleServe(
  state: DesktopServerExposureState | null,
  endpointUrl: string | null,
): TailscaleServePresentation {
  if (!state || !state.tailscaleServeRequested) {
    return {
      label: "Off",
      description:
        "Private HTTPS access for devices on your tailnet. This does not enable Funnel or public access.",
      isError: false,
      canRetry: false,
    };
  }

  switch (state.tailscaleServeStatus) {
    case "checking":
      return {
        label: "Checking…",
        description: "Checking Tailscale and the private HTTPS endpoint.",
        isError: false,
        canRetry: false,
      };
    case "available":
      return {
        label: "Private",
        description:
          endpointUrl === null
            ? "Tailscale HTTPS is ready for devices signed into the same tailnet. Funnel remains off."
            : `${endpointUrl} Create a one-time link under Authorized clients; its QR opens this private endpoint and pairs the phone safely.`,
        isError: false,
        canRetry: true,
      };
    case "tailscale-not-installed":
      return {
        label: "Tailscale not found",
        description: "Install Tailscale on this computer, sign in, then check again.",
        isError: true,
        canRetry: true,
      };
    case "tailscale-not-running":
      return {
        label: "Tailscale stopped",
        description: "Start Tailscale on this computer, then check again.",
        isError: true,
        canRetry: true,
      };
    case "tailscale-not-authenticated":
      return {
        label: "Sign-in required",
        description: "Sign in to Tailscale and make sure this computer is connected to a tailnet.",
        isError: true,
        canRetry: true,
      };
    case "https-consent-required":
      return {
        label: "Approval required",
        description:
          "Your tailnet must approve HTTPS certificates before private Serve access can start.",
        isError: false,
        canRetry: true,
      };
    case "port-conflict":
      return {
        label: "Port in use",
        description: `Tailscale HTTPS port ${String(state.tailscaleServePort)} is already in use. Choose another port or clear its existing Serve mapping.`,
        isError: true,
        canRetry: true,
      };
    case "endpoint-unreachable":
      return {
        label: "Not reachable",
        description:
          "Serve was configured, but the HTTPS endpoint did not answer yet. Check Tailscale connectivity and retry.",
        isError: true,
        canRetry: true,
      };
    case "serve-failed":
      return {
        label: "Setup failed",
        description:
          "Tailscale Serve could not be configured. Check Tailscale status and the selected HTTPS port, then retry.",
        isError: true,
        canRetry: true,
      };
    case "disabled":
      return {
        label: "Waiting to start",
        description: "Private HTTPS was requested but is not active. Check again to retry setup.",
        isError: true,
        canRetry: true,
      };
  }
}
