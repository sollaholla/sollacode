import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";

export function ProviderAccountSwitchConfirmation(props: {
  readonly open: boolean;
  readonly environmentLabel: string | null;
  readonly authenticationPaused: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out and switch provider account?</AlertDialogTitle>
          <AlertDialogDescription>
            This signs out the current provider account. You’ll need to sign in again to use that
            provider. Authentication runs on {props.environmentLabel || "the host machine"}, where
            the provider is installed. If you’re using a phone, use remote control or access that
            machine to finish browser sign-in.{" "}
            {props.authenticationPaused
              ? "This conversation is paused and will continue automatically once sign-in succeeds."
              : "The conversation can keep running while you switch accounts."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button onClick={props.onConfirm}>Sign out and continue</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
