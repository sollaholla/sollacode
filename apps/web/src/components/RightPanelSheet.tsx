import { type ReactNode, useRef } from "react";

import { RIGHT_PANEL_SHEET_CLASS_NAME } from "../rightPanelLayout";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        ref={popupRef}
        // Keyboard opens keep the default (the first tab). Anything else, such
        // as arriving from a notification, focuses the sheet itself: focus
        // stays inside it without lighting up the first tab and its tooltip.
        initialFocus={(openType) => (openType === "keyboard" ? true : popupRef.current)}
        side="right"
        showCloseButton={false}
        className={RIGHT_PANEL_SHEET_CLASS_NAME}
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
