import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { withFirstRunTransition } from "./firstRunTransition";
import { FirstRunSurface } from "./FirstRunSurface";
import { WelcomeTour } from "./WelcomeTour";
import { useWelcomeTourReplayStore } from "./welcomeTourStore";

/** The tour again, over whatever screen someone asked for it from. */
export default function WelcomeTourReplay() {
  const setOpen = useWelcomeTourReplayStore((state) => state.setOpen);
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => setOpen(open)} disablePointerDismissal>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup aria-label="Welcome tour" className="outline-none">
          <FirstRunSurface className="z-[70]">
            <WelcomeTour
              doneLabel="Done"
              onDone={() => withFirstRunTransition(() => setOpen(false))}
            />
          </FirstRunSurface>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
