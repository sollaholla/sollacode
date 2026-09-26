import { useEffect, useRef, useState } from "react";
import type {
  EnvironmentId,
  ProviderApiKeyAccount,
  ProviderApiKeyAccountAction,
  ProviderApiKeyAccounts as Accounts,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { CheckIcon, KeyRoundIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";

export function ProviderApiKeyAccountsView(props: {
  readonly instanceId: ProviderInstanceId;
  readonly accounts: Accounts | undefined;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onAction: (action: ProviderApiKeyAccountAction) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<ProviderApiKeyAccount | "new" | null>(null);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com");
  const [activate, setActivate] = useState(true);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const accounts = props.accounts?.accounts ?? [];
  const activeId = props.accounts?.activeAccountId ?? null;
  const startEdit = (account: ProviderApiKeyAccount | "new") => {
    setEditing(account);
    setName(account === "new" ? "" : account.name);
    setKey("");
    setBaseUrl(account === "new" ? "https://api.deepseek.com" : account.baseUrl);
    setActivate(account === "new" || account.id === activeId);
    setValidation(null);
    setRemoveId(null);
  };
  const save = async () => {
    if (!editing || props.pending) return;
    const nextName = name.trim();
    const nextKey = key.trim();
    if (!nextName || (editing === "new" && !nextKey)) {
      setValidation("Enter an account name and API key.");
      return;
    }
    if (nextKey && /\s/.test(nextKey)) {
      setValidation("The API key cannot contain spaces or line breaks.");
      return;
    }
    if (
      accounts.some(
        (item) =>
          (editing === "new" || item.id !== editing.id) &&
          item.name.toLowerCase() === nextName.toLowerCase(),
      )
    ) {
      setValidation("Choose a different name for this account.");
      return;
    }
    try {
      const endpoint = new URL(baseUrl.trim());
      if (
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        (endpoint.protocol !== "https:" &&
          !(
            endpoint.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
          ))
      )
        throw new Error();
    } catch {
      setValidation("Enter an HTTPS API endpoint without a password, query, or fragment.");
      return;
    }
    if (editing !== "new" && baseUrl.trim().replace(/\/$/, "") !== editing.baseUrl && !nextKey) {
      setValidation("Enter a new key when changing the API endpoint.");
      return;
    }
    setValidation(null);
    const ok = await props.onAction({
      action: "save",
      instanceId: props.instanceId,
      id: editing === "new" ? randomUUID() : editing.id,
      name: nextName,
      baseUrl: baseUrl.trim(),
      activate,
      ...(nextKey ? { apiKey: nextKey } : {}),
    });
    setKey("");
    if (ok) setEditing(null);
  };
  return (
    <section className="min-w-0 space-y-4" aria-label="Named API-key accounts">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          <KeyRoundIcon className="size-4" />
          API-key accounts
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={props.pending || accounts.length >= 20}
          onClick={() => startEdit("new")}
        >
          <PlusIcon className="size-3.5" />
          Add key
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Save a name and key for each Deep Code account. The selected account is used for new work
        and balance checks. Running work keeps its current key.
      </p>
      <div className="space-y-2">
        {accounts.length === 0 ? (
          <p className="rounded-xl border border-border border-dashed p-4 text-center text-muted-foreground text-sm">
            No saved keys yet. Add your DeepSeek API key to get started.
          </p>
        ) : null}
        {accounts.map((account) => (
          <div
            key={account.id}
            className="min-w-0 rounded-xl border border-border bg-card/40 p-4 max-sm:p-3.5"
          >
            <div className="flex min-w-0 items-start gap-3">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="break-words font-medium text-sm">{account.name}</span>
                  {account.id === activeId ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-[11px] text-primary">
                      <CheckIcon className="size-3" />
                      Active
                    </span>
                  ) : null}
                </div>
                <p className="break-all font-mono text-muted-foreground text-xs">
                  •••• {account.keySuffix}
                </p>
                <p className="break-all text-muted-foreground text-xs">{account.baseUrl}</p>
              </div>
              {/* Icon-only controls sit inside a 44px row on touch: at icon-sm
                  alone they were a ~28px target next to each other. */}
              <div className="-mr-1 flex shrink-0 items-center gap-0.5">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="size-9 max-sm:size-10"
                  disabled={props.pending}
                  aria-label={`Edit ${account.name}`}
                  onClick={() => startEdit(account)}
                >
                  <PencilIcon className="size-4" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="size-9 max-sm:size-10"
                  disabled={props.pending}
                  aria-label={`Remove ${account.name}`}
                  onClick={() => setRemoveId(account.id)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            </div>
            {removeId === account.id ? (
              <div
                className="mt-3 space-y-2"
                role="group"
                aria-label={`Confirm removal of ${account.name}`}
              >
                <p className="text-xs text-muted-foreground">
                  Remove this saved key?
                  {account.id === activeId
                    ? " New work will use the CLI's configured credentials."
                    : ""}{" "}
                  Running work is unaffected.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={props.pending}
                    onClick={async () => {
                      if (
                        await props.onAction({
                          action: "remove",
                          instanceId: props.instanceId,
                          id: account.id,
                        })
                      )
                        setRemoveId(null);
                    }}
                  >
                    Remove key
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={props.pending}
                    onClick={() => setRemoveId(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : account.id !== activeId ? (
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                disabled={props.pending}
                onClick={() =>
                  void props.onAction({
                    action: "select",
                    instanceId: props.instanceId,
                    id: account.id,
                  })
                }
              >
                Use this key
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      {accounts.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 border-dashed px-4 py-3 max-sm:px-3.5">
          <div className="min-w-0">
            <p className="font-medium text-sm">CLI credentials</p>
            <p className="text-muted-foreground text-xs">
              {activeId === null
                ? "In use for new work."
                : "Fall back to whatever the CLI is configured with."}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={props.pending || activeId === null}
            onClick={() =>
              void props.onAction({ action: "select", instanceId: props.instanceId, id: null })
            }
          >
            {activeId === null ? "In use" : "Use these"}
          </Button>
        </div>
      ) : null}
      {editing ? (
        <form
          className="space-y-4 rounded-xl border border-border bg-muted/20 p-4 max-sm:p-3.5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="text-sm font-medium">
            {editing === "new" ? "Add API key" : `Edit ${editing.name}`}
          </p>
          <label className="block space-y-1.5 text-xs">
            <span>Account name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Personal, Work…"
              maxLength={80}
              disabled={props.pending}
              autoComplete="off"
              required
            />
          </label>
          <label className="block space-y-1.5 text-xs">
            <span>{editing === "new" ? "API key" : "Replace API key (optional)"}</span>
            <Input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={
                editing === "new" ? "Paste your API key" : "Leave empty to keep the saved key"
              }
              maxLength={4096}
              disabled={props.pending}
              autoComplete="new-password"
              spellCheck={false}
              autoCapitalize="none"
              required={editing === "new"}
            />
          </label>
          <label className="block space-y-1.5 text-xs">
            <span>API endpoint</span>
            <Input
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              maxLength={2048}
              disabled={props.pending}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Direct DeepSeek accounts support balance reporting. Custom endpoints use their own
            billing.
          </p>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={activate}
              onCheckedChange={(value) => setActivate(Boolean(value))}
              disabled={props.pending}
            />
            Use this account for new work
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={props.pending}>
              {props.pending ? "Saving…" : "Save key"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={props.pending}
              onClick={() => {
                setEditing(null);
                setKey("");
                setValidation(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {validation || props.error ? (
        <p role="alert" className="text-xs text-destructive">
          {validation ?? props.error}
        </p>
      ) : null}
      <p className="border-border/60 border-t pt-3 text-muted-foreground text-xs leading-relaxed">
        Keys are stored securely on this environment. Saved keys are never sent back to the app.
      </p>
    </section>
  );
}

export function ProviderApiKeyAccountsSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const accounts = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.providerApiKeyAccounts?.[props.instanceId],
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    busy.current = false;
    setPending(false);
    setError(null);
    return () => {
      generation.current++;
    };
  }, [props.environmentId, props.instanceId]);
  return (
    <ProviderApiKeyAccountsView
      key={`${props.environmentId}:${props.instanceId}`}
      instanceId={props.instanceId}
      accounts={accounts}
      pending={pending}
      error={error}
      onAction={async (action) => {
        if (busy.current) return false;
        busy.current = true;
        setPending(true);
        setError(null);
        const currentGeneration = generation.current;
        const result = await updateSettings({
          environmentId: props.environmentId,
          input: { patch: { providerApiKeyAccountAction: action } },
        });
        if (currentGeneration !== generation.current) return false;
        busy.current = false;
        setPending(false);
        if (result._tag === "Failure") {
          setError("Could not confirm the account update. Check the connection and try again.");
          return false;
        }
        return true;
      }}
    />
  );
}

export function ProviderApiKeyAccountDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-h-[min(85dvh,48rem)] overflow-y-auto">
        <DialogHeader className="pb-0">
          <DialogTitle>Switch Deep Code account</DialogTitle>
          <DialogDescription>Choose a saved API key or add an account.</DialogDescription>
        </DialogHeader>
        {/* The view is unpadded by design - inside the provider card its parent
            already pads it - so the dialog supplies its own gutters. Without
            these every row ran edge to edge on a phone. */}
        <div className="px-6 pb-6 max-sm:px-4 max-sm:pb-5">
          <ProviderApiKeyAccountsSettings
            environmentId={props.environmentId}
            instanceId={props.instanceId}
          />
        </div>
      </DialogPopup>
    </Dialog>
  );
}
