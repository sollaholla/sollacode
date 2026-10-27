import type {
  DeviceCatalog,
  DevicePlatform,
  DeviceSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  DEVICE_PLATFORM_LABELS,
  deviceDraftProblem,
  findCatalog,
  initialDeviceDraft,
  selectDeviceModel,
  systemsForModel,
  type DeviceDraft,
} from "@t3tools/client-runtime/devices/device-logic";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { deviceEnvironment } from "~/state/devices";
import { useAtomCommand } from "~/state/use-atom-command";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { deviceFailureMessage } from "./useDevices";

/** Adds an iOS simulator or Android emulator of any model the machine's tools offer. */
export function AddDeviceDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  /** Platforms whose tools are installed, in the order to offer them. */
  readonly platforms: ReadonlyArray<DevicePlatform>;
  readonly onAdded: (device: DeviceSummary) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="w-full max-w-md">
        <AddDeviceForm
          environmentId={props.environmentId}
          platforms={props.platforms}
          onCancel={() => props.onOpenChange(false)}
          onAdded={(device) => {
            props.onAdded(device);
            props.onOpenChange(false);
          }}
        />
      </DialogPopup>
    </Dialog>
  );
}

function AddDeviceForm(props: {
  readonly environmentId: EnvironmentId;
  readonly platforms: ReadonlyArray<DevicePlatform>;
  readonly onCancel: () => void;
  readonly onAdded: (device: DeviceSummary) => void;
}) {
  const loadCatalog = useAtomCommand(deviceEnvironment.catalog, { reportFailure: false });
  const create = useAtomCommand(deviceEnvironment.create, { reportFailure: false });
  const commands = useRef({ loadCatalog, create });
  commands.current = { loadCatalog, create };
  const [catalog, setCatalog] = useState<DeviceCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<DevicePlatform>(props.platforms[0] ?? "ios");
  const [drafts, setDrafts] = useState<Partial<Record<DevicePlatform, DeviceDraft>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();

  useEffect(() => {
    let active = true;
    void commands.current
      .loadCatalog({ environmentId: props.environmentId, input: {} })
      .then((outcome) => {
        if (!active) return;
        const failure = deviceFailureMessage(outcome, "Couldn't read the available models.");
        if (failure !== null) setLoadError(failure);
        else if (outcome._tag === "Success") setCatalog(outcome.value);
      });
    return () => {
      active = false;
    };
  }, [props.environmentId]);

  const platformCatalog = findCatalog(catalog, platform);
  const draft = platformCatalog ? (drafts[platform] ?? initialDeviceDraft(platformCatalog)) : null;
  const updateDraft = (next: DeviceDraft) =>
    setDrafts((current) => ({ ...current, [platform]: next }));
  const problem = platformCatalog && draft ? deviceDraftProblem(platformCatalog, draft) : null;
  const systems = platformCatalog && draft ? systemsForModel(platformCatalog, draft.modelId) : [];

  const modelItems = useMemo(
    () => platformCatalog?.models.map((model) => ({ value: model.id, label: model.name })) ?? [],
    [platformCatalog],
  );
  const systemItems = systems.map((system) => ({ value: system.id, label: system.name }));
  const modelGroups = [
    { label: "Phones", kind: "phone" },
    { label: "Tablets", kind: "tablet" },
  ]
    .map((group) => ({
      label: group.label,
      models: platformCatalog?.models.filter((model) => model.kind === group.kind) ?? [],
    }))
    .filter((group) => group.models.length > 0);

  const submit = async () => {
    if (!draft || problem !== null || busy) return;
    setBusy(true);
    setError(null);
    const outcome = await commands.current.create({
      environmentId: props.environmentId,
      input: {
        platform,
        name: draft.name.trim(),
        modelId: draft.modelId,
        systemId: draft.systemId,
      },
    });
    const failure = deviceFailureMessage(outcome, "Couldn't add the device.");
    if (failure !== null) {
      setError(failure);
      setBusy(false);
      return;
    }
    if (outcome._tag === "Success") props.onAdded(outcome.value);
  };

  let body;
  if (loadError !== null) {
    body = (
      <Alert variant="error">
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  } else if (catalog === null) {
    body = (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Reading the available models…
      </div>
    );
  } else if (platformCatalog === null || draft === null) {
    body = (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {platform === "ios"
          ? "Xcode didn't report any simulator models."
          : "The Android SDK didn't report any emulator models."}
      </p>
    );
  } else {
    body = (
      <>
        <div className="space-y-1.5">
          <Label>Model</Label>
          <Select
            value={draft.modelId}
            items={modelItems}
            onValueChange={(value) => {
              if (typeof value === "string") {
                updateDraft(selectDeviceModel(platformCatalog, draft, value));
              }
            }}
          >
            <SelectTrigger aria-label="Model">
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectPopup className="max-h-80">
              {modelGroups.map((group) => (
                <SelectGroup key={group.label}>
                  <SelectGroupLabel>{group.label}</SelectGroupLabel>
                  {group.models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{platform === "ios" ? "iOS version" : "Android version"}</Label>
          <Select
            value={draft.systemId}
            items={systemItems}
            onValueChange={(value) => {
              if (typeof value === "string") updateDraft({ ...draft, systemId: value });
            }}
          >
            <SelectTrigger aria-label={platform === "ios" ? "iOS version" : "Android version"}>
              <SelectValue placeholder="Choose a version" />
            </SelectTrigger>
            <SelectPopup>
              {systems.map((system) => (
                <SelectItem key={system.id} value={system.id}>
                  {system.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <p className="text-xs text-muted-foreground">
            {platform === "ios"
              ? "More iOS versions: Xcode → Settings → Components."
              : "More Android versions: Android Studio → SDK Manager."}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={nameId}>Name</Label>
          <Input
            id={nameId}
            autoComplete="off"
            value={draft.name}
            maxLength={64}
            onChange={(event) =>
              updateDraft({ ...draft, name: event.target.value, nameEdited: true })
            }
          />
        </div>
        {platformCatalog.detail ? (
          <Alert variant="warning">
            <AlertDescription>{platformCatalog.detail}</AlertDescription>
          </Alert>
        ) : null}
      </>
    );
  }

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Add a device</DialogTitle>
        <DialogDescription>
          Creates a new simulator or emulator on the computer running Solla Code. It starts the
          first time you open it.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        {props.platforms.length > 1 ? (
          <ToggleGroup
            variant="outline"
            className="w-full *:flex-1"
            value={[platform]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "ios" || next === "android") {
                setPlatform(next);
                setError(null);
              }
            }}
          >
            {props.platforms.map((option) => (
              <Toggle key={option} value={option} aria-label={DEVICE_PLATFORM_LABELS[option]}>
                {option === "ios" ? "iPhone & iPad" : "Android"}
              </Toggle>
            ))}
          </ToggleGroup>
        ) : null}
        {body}
        {error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || problem !== null || draft === null}>
          {busy ? <Spinner className="size-4" /> : null}
          {busy ? "Adding…" : "Add device"}
        </Button>
      </DialogFooter>
    </form>
  );
}
