import { SidebarInset } from "./ui/sidebar";

/**
 * What a pane shows while its content loads after startup, instead of an
 * empty screen. Static text: nothing here animates.
 */
export function PaneLoadingState({ label }: { readonly label: string }) {
  return (
    <div
      role="status"
      className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background px-6 text-sm text-muted-foreground"
    >
      {label}
    </div>
  );
}

/** A route-level loading state that takes the main pane's place. */
export function RouteLoadingState({ label }: { readonly label: string }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <PaneLoadingState label={label} />
    </SidebarInset>
  );
}
