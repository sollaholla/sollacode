import { useEffect, useId, useState } from "react";
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
    <div className="space-y-3 text-sm">
      <label className="grid gap-1" htmlFor={`${id}-mode`}>
        Model access
        <select
          id={`${id}-mode`}
          className="rounded-md border border-border bg-background p-2"
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
          <input
            aria-label="Search models for restrictions"
            className="w-full rounded-md border border-border bg-background p-2"
            placeholder="Search models…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="max-h-60 space-y-1 overflow-y-auto rounded-md border border-border p-2">
            {visible.map((row) => (
              <label
                key={`${row.instanceId}:${row.model}`}
                className="flex cursor-pointer items-start gap-2 rounded p-1.5 hover:bg-muted"
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
                              !(entry.instanceId === row.instanceId && entry.model === row.model),
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
            {catalog.filter((row) => modelAccessPolicyAllows(draft, row)).length} allowed in this
            list.{" "}
            {draft.mode === "allow" && draft.models.length === 0
              ? "No models are allowed. Work will wait until you allow one."
              : "Restrictions apply to the exact provider account shown."}
          </p>
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
