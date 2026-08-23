import { useLocation } from "@tanstack/react-router";

import { useCloseMobileSidebarOnNavigate } from "./useCloseMobileSidebarOnNavigate";

/**
 * Mount once inside the sidebar provider to make dismissal automatic.
 *
 * Renders nothing; it exists because the rule needs the sidebar context, which
 * only components beneath the provider can read.
 */
export function CloseMobileSidebarOnNavigate() {
  const href = useLocation({ select: (location) => location.href });
  useCloseMobileSidebarOnNavigate(href);
  return null;
}
