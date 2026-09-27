import { useEffect, useId, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  DEFAULT_MODEL_ACCESS_POLICY,
  type EnvironmentId,
  type ModelAccessPolicy,
  type ServerProvider,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { modelAccessPolicyAllows } from "@t3tools/shared/modelAccessPolicy";
import { Button } from "../ui/button";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useMediaQuery } from "../../hooks/useMediaQuery";

export function useSaveModelPolicy(environmentId: EnvironmentId | null) {
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return async (patch: ServerSettingsPatch) => {
    if (!environmentId)
      throw new Error("Connect to this environment before changing model restrictions.");
    const result = await update({ environmentId, input: { patch } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  };
}

export function ModelPolicyEditor(props: {
  policy: ModelAccessPolicy | undefined;
  providers: ReadonlyArray<ServerProvider>;
  onSave: (policy: ModelAccessPolicy) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState(props.policy ?? DEFAULT_MODEL_ACCESS_POLICY);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const compact = useMediaQuery("max-sm");
  const [modelsExpanded, setModelsExpanded] = useState(false);
  useEffect(() => {
    setDraft(props.policy ?? DEFAULT_MODEL_ACCESS_POLICY);
  }, [props.policy]);
  const catalog = props.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      instanceId: provider.instanceId,
      model: model.slug,
      label: `${model.name} · ${provider.displayName ?? provider.instanceId}`,
    })),
  );
  for (const entry of draft.models) {
    if (!catalog.some((row) => row.instanceId === entry.instanceId && row.model === entry.model))
      catalog.push({
        ...entry,
        label: `${entry.model} · ${entry.instanceId} (currently unavailable)`,
      });
  }
  const visible = catalog.filter((row) => row.label.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="space-y-2 text-sm sm:space-y-3">
      <label
        className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 sm:grid-cols-1 sm:gap-1"
        htmlFor={`${id}-mode`}
      >
        Model access
        <select
          id={`${id}-mode`}
          className="min-h-11 min-w-0 w-full rounded-md border border-border bg-background p-2 sm:min-h-0"
          disabled={saving}
          value={draft.mode}
          onChange={(event) => {
            setNotice(null);
            setDraft({ ...draft, mode: event.target.value as ModelAccessPolicy["mode"] });
          }}
        >
          <option value="all">Allow all models</option>
          <option value="block">Block selected models</option>
          <option value="allow">Allow only selected models</option>
        </select>
      </label>
      {draft.mode !== "all" && (
        <>
          {compact && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full justify-between"
              aria-expanded={modelsExpanded}
              aria-controls={`${id}-models`}
              onClick={() => setModelsExpanded((expanded) => !expanded)}
            >
              <span>Models · {draft.models.length} selected</span>
              <ChevronDownIcon aria-hidden className={modelsExpanded ? "rotate-180" : undefined} />
            </Button>
          )}
          {(!compact || modelsExpanded) && (
            <div id={`${id}-models`} className="space-y-2">
              <input
                aria-label="Search models for restrictions"
                className="w-full rounded-md border border-border bg-background p-2"
                placeholder="Search models…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2 sm:max-h-60">
                {visible.map((row) => (
                  <label
                    key={`${row.instanceId}:${row.model}`}
                    className="flex min-h-11 cursor-pointer items-start gap-2 rounded p-1.5 hover:bg-muted sm:min-h-0"
                  >
                    <input
                      type="checkbox"
                      disabled={saving}
                      className="mt-1"
                      checked={draft.models.some(
                        (entry) => entry.instanceId === row.instanceId && entry.model === row.model,
                      )}
                      onChange={(event) => {
                        setNotice(null);
                        setDraft({
                          ...draft,
                          models: event.target.checked
                            ? [...draft.models, { instanceId: row.instanceId, model: row.model }]
                            : draft.models.filter(
                                (entry) =>
                                  !(
                                    entry.instanceId === row.instanceId && entry.model === row.model
                                  ),
                              ),
                        });
                      }}
                    />
                    <span>{row.label}</span>
                  </label>
                ))}
                {visible.length === 0 && (
                  <p className="p-2 text-muted-foreground">No matching models.</p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {draft.models.length} selected ·{" "}
                {catalog.filter((row) => modelAccessPolicyAllows(draft, row)).length} allowed in
                this list. Restrictions apply to the exact provider account shown.
              </p>
            </div>
          )}
          {draft.mode === "allow" && draft.models.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No models are allowed. Work will wait until you allow one.
            </p>
          )}
        </>
      )}
      <Button
        type="button"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          setNotice(null);
          try {
            await props.onSave(draft);
            setNotice("Restrictions saved.");
          } catch (error) {
            setNotice(error instanceof Error ? error.message : "Could not save restrictions.");
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? "Saving…" : "Save restrictions"}
      </Button>
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
    </div>
  );
}
