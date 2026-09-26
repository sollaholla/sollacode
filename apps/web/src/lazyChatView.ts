import { lazyRouteComponent } from "@tanstack/react-router";

/**
 * The chat view, loaded on demand. Shared by the thread and draft routes so
 * startup can begin its download while the app signs in.
 */
export const LazyChatView = lazyRouteComponent(() => import("./components/ChatView"));
