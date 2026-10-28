import { ChevronUpIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  listMicrophones,
  usePreferredMicrophone,
  type MicrophoneChoices,
} from "../../orchestrator/microphones";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";

/** The radio value standing for "follow the system default". */
const DEFAULT_VALUE = "default";

/**
 * The call's microphone choice: a small button on the Mute button that lists
 * the microphones. Default follows the system's microphone as it changes; a
 * chosen one is remembered on this device and used by every voice session.
 */
export function MicrophoneMenu(props: { readonly onChoose: (deviceId: string | null) => void }) {
  const [preferred, setPreferred] = usePreferredMicrophone();
  const [choices, setChoices] = useState<MicrophoneChoices | null>(null);
  const refresh = useCallback(() => {
    listMicrophones().then(setChoices, () => setChoices(null));
  }, []);
  useEffect(() => {
    refresh();
    const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    devices?.addEventListener?.("devicechange", refresh);
    return () => devices?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);

  const choose = (value: unknown) => {
    const deviceId = value === DEFAULT_VALUE || typeof value !== "string" ? null : value;
    // The call moves first: a choice that can't be stored still applies now.
    props.onChoose(deviceId);
    try {
      setPreferred(deviceId);
    } catch {
      // Storage unavailable (private mode, full): this call keeps the choice.
    }
  };
  const chosenMissing =
    preferred !== null &&
    choices !== null &&
    !choices.devices.some((device) => device.deviceId === preferred);

  return (
    <Menu onOpenChange={(open) => (open ? refresh() : undefined)}>
      <MenuTrigger
        aria-label="Choose microphone"
        className="absolute -right-1 -bottom-1 flex size-7 cursor-pointer items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm outline-hidden hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
      >
        <ChevronUpIcon />
      </MenuTrigger>
      <MenuPopup side="top" align="center" className="w-72">
        <MenuGroup>
          <MenuGroupLabel>Microphone</MenuGroupLabel>
          <MenuRadioGroup value={preferred ?? DEFAULT_VALUE} onValueChange={choose}>
            <MenuRadioItem value={DEFAULT_VALUE}>
              <span className="flex min-w-0 flex-col">
                <span>Default</span>
                <span className="truncate text-xs text-muted-foreground">
                  {choices?.defaultLabel
                    ? `${choices.defaultLabel}, follows your system`
                    : "Follows your system microphone"}
                </span>
              </span>
            </MenuRadioItem>
            {choices?.devices.map((device) =>
              device.deviceId === null ? null : (
                <MenuRadioItem key={device.deviceId} value={device.deviceId}>
                  <span className="min-w-0 truncate">{device.label}</span>
                </MenuRadioItem>
              ),
            )}
            {chosenMissing ? (
              <MenuRadioItem value={preferred} disabled>
                <span className="flex min-w-0 flex-col">
                  <span>Your chosen microphone</span>
                  <span className="text-xs text-muted-foreground">
                    Not connected; using the default until it is
                  </span>
                </span>
              </MenuRadioItem>
            ) : null}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
