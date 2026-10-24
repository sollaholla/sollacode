import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export function StorageCleanupRow(props: { environmentId: EnvironmentId; label: string }) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [saving, setSaving] = useState(false);
  return (
    <SettingsSwitchRow
      icon="internaldrive"
      label={props.label}
      disabled={!settings || saving}
      value={settings?.automaticStorageCleanupEnabled ?? true}
      onValueChange={async (enabled) => {
        setSaving(true);
        try {
          await update({
            environmentId: props.environmentId,
            input: { patch: { automaticStorageCleanupEnabled: enabled } },
          });
        } finally {
          setSaving(false);
        }
      }}
    />
  );
}
