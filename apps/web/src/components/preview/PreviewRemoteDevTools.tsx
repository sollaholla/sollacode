"use client";

import { cn } from "~/lib/utils";

/**
 * Chromium's own DevTools, for a guest running on another machine.
 *
 * The frontend runs here, in the viewer's browser, and speaks CDP back through
 * this environment's server to the guest — rather than the guest's machine
 * rendering DevTools and sending pixels. DevTools is a window beside the page
 * and never inside it, so it would never appear in a captured frame; and even
 * if it did, an inspector is not something to drive through a screenshot feed.
 *
 * Everything it reaches is proxied: the guest's debugging endpoint is bound to
 * its own loopback, and the server names the target rather than letting this
 * ask for one.
 */
export function PreviewRemoteDevTools(props: {
  readonly frontendUrl: string;
  readonly className?: string;
}) {
  const { frontendUrl, className } = props;

  // A sandbox allowing the scripts and storage DevTools needs is one the frame
  // can lift, so it would assert a boundary that is not there. The real one is
  // the proxy: loopback on the far side, this origin's own session on the near
  // one, and a target the host chose rather than the caller.
  return (
    // eslint-disable-next-line react/iframe-missing-sandbox -- see above
    <iframe
      src={frontendUrl}
      title="DevTools"
      className={cn("w-full border-t border-border/70 bg-background", className)}
    />
  );
}
