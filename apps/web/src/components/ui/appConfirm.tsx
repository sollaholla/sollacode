import { useSyncExternalStore } from "react";

import { Button } from "./button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./dialog";

/**
 * Confirmation that never freezes the app.
 *
 * `window.confirm` and Electron's `dialog.showMessageBox` both stop the
 * renderer's JavaScript thread until someone answers. That is not a cosmetic
 * difference: while one is open the page cannot run a timer, answer a debugger
 * evaluation, or repaint - so the app looks hung, remote control cannot be
 * started, and preview automation cannot even read the tab's viewport, because
 * the thread that would answer is the thread being blocked. One unanswered
 * dialog on one tab wedged every tab (2026-09-11).
 *
 * So Solla never shows a native dialog. This is the replacement: it resolves a
 * promise from ordinary React state, leaving the renderer free the whole time.
 */
export interface AppConfirmRequest {
  readonly id: number;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly alternateLabel?: string;
  readonly resolve: (choice: "confirm" | "alternate" | "cancel") => void;
}

let nextRequestId = 1;
let current: AppConfirmRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): AppConfirmRequest | null => current;

/**
 * Ask the user to confirm, without blocking anything.
 *
 * Resolves false when the host is not mounted, so a caller can never hang
 * waiting for UI that is not on screen - refusing a destructive action is the
 * safe answer when we cannot ask.
 */
export function confirmInApp(
  message: string,
  options?: { readonly confirmLabel?: string; readonly cancelLabel?: string },
): Promise<boolean> {
  return chooseInApp(message, options).then((choice) => choice === "confirm");
}

export function chooseInApp(
  message: string,
  options?: {
    readonly confirmLabel?: string;
    readonly cancelLabel?: string;
    readonly alternateLabel?: string;
  },
): Promise<"confirm" | "alternate" | "cancel"> {
  if (listeners.size === 0) return Promise.resolve("cancel");
  current?.resolve("cancel");
  return new Promise((resolve) => {
    current = {
      id: nextRequestId++,
      message,
      confirmLabel: options?.confirmLabel ?? "OK",
      cancelLabel: options?.cancelLabel ?? "Cancel",
      ...(options?.alternateLabel ? { alternateLabel: options.alternateLabel } : {}),
      resolve,
    };
    emit();
  });
}

function settle(confirmed: "confirm" | "alternate" | "cancel"): void {
  const request = current;
  current = null;
  emit();
  request?.resolve(confirmed);
}

/** Mounted once at the app root, beside the toast host. */
export function AppConfirmHost() {
  const request = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return (
    <Dialog
      open={request !== null}
      // Escape and outside-click both resolve to "no". A confirmation the user
      // dismisses is a confirmation they declined, and leaving it un-resolved
      // is how a dialog becomes the thing that blocks the app.
      onOpenChange={(open) => {
        if (!open) settle("cancel");
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Please confirm</DialogTitle>
          <DialogDescription>{request?.message ?? ""}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" onClick={() => settle("cancel")} />}>
            {request?.cancelLabel ?? "Cancel"}
          </DialogClose>
          {request?.alternateLabel ? (
            <Button variant="outline" onClick={() => settle("alternate")}>
              {request.alternateLabel}
            </Button>
          ) : null}
          <Button onClick={() => settle("confirm")}>{request?.confirmLabel ?? "OK"}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
