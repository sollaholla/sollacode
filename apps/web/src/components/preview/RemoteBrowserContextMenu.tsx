import type { PreviewContextMenuTarget } from "@t3tools/contracts";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { remoteContextMenuItems, type RemoteContextMenuItemId } from "./remoteBrowserInput";

const EDGE_PX = 8;

/**
 * The desktop tab's right-click menu, drawn on the viewer's own screen: the
 * host's native menu would open on a desktop nobody is looking at. Stateless -
 * the frame decides what each item does.
 */
export function RemoteBrowserContextMenu(props: {
  readonly target: PreviewContextMenuTarget;
  readonly at: { readonly x: number; readonly y: number };
  readonly canOpenInNewTab: boolean;
  readonly onChoose: (item: RemoteContextMenuItemId) => void;
  readonly onClose: () => void;
}) {
  const { onClose } = props;
  const groups = remoteContextMenuItems(props.target, { canOpenInNewTab: props.canOpenInNewTab });
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(props.at);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (element === null) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      x: Math.max(EDGE_PX, Math.min(props.at.x, window.innerWidth - width - EDGE_PX)),
      y: Math.max(EDGE_PX, Math.min(props.at.y, window.innerHeight - height - EDGE_PX)),
    });
  }, [props.at]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (groups.length === 0) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[200]"
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={menuRef}
        role="menu"
        aria-label="Page menu"
        className="fixed max-h-[80vh] min-w-48 max-w-72 overflow-y-auto rounded-lg border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg"
        style={{ left: position.x, top: position.y }}
      >
        {groups.map((group, index) => (
          <Fragment key={group[0]!.id}>
            {index > 0 ? <div className="my-1 h-px bg-border" role="separator" /> : null}
            {group.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="block w-full px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onClick={() => props.onChoose(item.id)}
              >
                {item.label}
              </button>
            ))}
          </Fragment>
        ))}
      </div>
    </div>,
    document.body,
  );
}
