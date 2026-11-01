import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  PROVIDER_SETUP_VERSION,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  LogInIcon,
  RefreshCwIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderSettingsAuthDialog } from "../settings/ProviderSettingsSignIn";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  buildProviderSetupEnablementPatch,
  defaultProviderSetupSelection,
  deriveProviderSetupNeed,
  deriveProviderSetupOptions,
  describeProviderSetupDetection,
  isProviderDetected,
  type ProviderSetupNeed,
  type ProviderSetupOption,
} from "./providerSetup.logic";

/**
 * First-run provider setup: choose which providers to turn on, then install
 * or sign in to each one. Every step can be skipped; finishing or skipping
 * records the setup version so it does not open again.
 */
export function ProviderSetup({ onDone }: { readonly onDone: () => void }) {
  const environment = usePrimaryEnvironment();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const options = useMemo(
    () => deriveProviderSetupOptions({ settings, providers }),
    [providers, settings],
  );
  const [step, setStep] = useState<"choose" | "sign-in">("choose");
  // Follows detection until the person changes a box, then holds their choice.
  const [explicitSelection, setExplicitSelection] =
    useState<ReadonlySet<ProviderDriverKind> | null>(null);
  const selection = explicitSelection ?? defaultProviderSetupSelection(options);
  const [chosen, setChosen] = useState<ReadonlyArray<ProviderDriverKind>>([]);

  const finish = useCallback(() => {
    updateSettings({ providerSetupVersion: PROVIDER_SETUP_VERSION });
    onDone();
  }, [onDone, updateSettings]);

  const toggle = (driver: ProviderDriverKind, checked: boolean) => {
    const next = new Set(selection);
    if (checked) next.add(driver);
    else next.delete(driver);
    setExplicitSelection(next);
  };

  const continueToSignIn = () => {
    const patch = buildProviderSetupEnablementPatch({ settings, options, selection });
    if (patch) updateSettings(patch);
    setChosen(options.filter((option) => selection.has(option.driver)).map((o) => o.driver));
    setStep("sign-in");
  };

  const chosenOptions = options.filter((option) => chosen.includes(option.driver));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col px-5 pt-10 sm:px-8 sm:pt-16">
      <p className="text-xs font-medium tracking-wide text-muted-foreground">
        STEP {step === "choose" ? 1 : 2} OF 2
      </p>
      {step === "choose" ? (
        <>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Which AI do you use?
          </h1>
          <p className="mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground">
            Solla Code works with these AI tools. Turn on the ones you want. You can change this
            anytime in Settings.
          </p>
          <ul
            aria-label="AI tools"
            className="mt-8 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/30"
          >
            {options.map((option) => (
              <ProviderChoiceRow
                key={option.driver}
                option={option}
                checked={selection.has(option.driver)}
                onCheckedChange={(checked) => toggle(option.driver, checked)}
              />
            ))}
          </ul>
          <div className="sticky bottom-0 -mx-5 mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-background/95 px-5 py-4 backdrop-blur-sm sm:-mx-8 sm:px-8">
            <Button variant="ghost" onClick={finish}>
              Skip setup
            </Button>
            <div className="flex items-center gap-3">
              {selection.size === 0 ? (
                <span className="text-xs text-muted-foreground">Choose at least one</span>
              ) : null}
              <Button disabled={selection.size === 0} onClick={continueToSignIn}>
                Continue <ArrowRightIcon aria-hidden className="size-4" />
              </Button>
            </div>
          </div>
        </>
      ) : (
        <ProviderSignInStep
          options={chosenOptions}
          environmentId={environment?.environmentId ?? null}
          environmentLabel={environment?.label ?? "this computer"}
          onBack={() => setStep("choose")}
          onFinish={finish}
        />
      )}
    </div>
  );
}

function ProviderIcon({ option }: { readonly option: ProviderSetupOption }) {
  const Icon = option.definition.icon;
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
      <Icon aria-hidden className="size-4.5 text-foreground/80" />
    </span>
  );
}

function ProviderChoiceRow({
  option,
  checked,
  onCheckedChange,
}: {
  readonly option: ProviderSetupOption;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const detected = isProviderDetected(option);
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/30 sm:px-5">
        <ProviderIcon option={option} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{option.definition.label}</span>
            {option.definition.badgeLabel ? (
              <Badge variant="warning" size="sm">
                {option.definition.badgeLabel}
              </Badge>
            ) : null}
          </span>
          <span
            className={cn(
              "mt-0.5 block truncate text-xs",
              detected ? "text-success-foreground" : "text-muted-foreground",
            )}
          >
            {describeProviderSetupDetection(option)}
          </span>
        </span>
        <Checkbox
          checked={checked}
          onCheckedChange={(next) => onCheckedChange(next === true)}
          aria-label={`Use ${option.definition.label}`}
        />
      </label>
    </li>
  );
}

function ProviderSignInStep({
  options,
  environmentId,
  environmentLabel,
  onBack,
  onFinish,
}: {
  readonly options: ReadonlyArray<ProviderSetupOption>;
  readonly environmentId: EnvironmentId | null;
  readonly environmentLabel: string;
  readonly onBack: () => void;
  readonly onFinish: () => void;
}) {
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState<ReadonlySet<ProviderInstanceId>>(new Set());
  const [signingIn, setSigningIn] = useState<ProviderSetupOption | null>(null);
  const needs = options.map((option) => ({ option, need: deriveProviderSetupNeed(option) }));
  const pendingCount = needs.filter(({ need }) => need.kind !== "ready").length;

  const withBusy = useCallback(
    async (instanceId: ProviderInstanceId, work: () => Promise<void>) => {
      setBusy((current) => new Set(current).add(instanceId));
      try {
        await work();
      } finally {
        setBusy((current) => {
          const next = new Set(current);
          next.delete(instanceId);
          return next;
        });
      }
    },
    [],
  );

  const refresh = useCallback(
    (instanceId: ProviderInstanceId) =>
      withBusy(instanceId, async () => {
        if (!environmentId) return;
        await refreshProviders({ environmentId, input: { instanceId } });
      }),
    [environmentId, refreshProviders, withBusy],
  );

  const install = (option: ProviderSetupOption) =>
    withBusy(option.instanceId, async () => {
      if (!environmentId) return;
      const result = await updateProvider({
        environmentId,
        input: { provider: option.driver, instanceId: option.instanceId, action: "install" },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: `Could not install ${option.definition.label}`,
          description: (() => {
            const error = squashAtomCommandFailure(result);
            return error instanceof Error ? error.message : "The install did not start.";
          })(),
        });
        return;
      }
      await refreshProviders({ environmentId, input: { instanceId: option.instanceId } });
    });

  // Terminal and browser sign-ins finish outside this window; check again
  // when the person comes back instead of polling.
  const unresolvedIdsRef = useRef<ReadonlyArray<ProviderInstanceId>>([]);
  unresolvedIdsRef.current = needs
    .filter(({ need }) => need.kind.startsWith("sign-in") || need.kind === "attention")
    .map(({ option }) => option.instanceId);
  useEffect(() => {
    const onFocus = () => {
      for (const instanceId of unresolvedIdsRef.current) void refresh(instanceId);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return (
    <>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
        Sign in to your providers
      </h1>
      <p className="mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground">
        Each provider uses its own account on {environmentLabel}. No separate Solla Code account is
        needed.
      </p>
      <ul
        aria-label="Provider sign-in"
        className="mt-8 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/30"
      >
        {needs.map(({ option, need }) => (
          <ProviderSignInRow
            key={option.driver}
            option={option}
            need={need}
            busy={busy.has(option.instanceId)}
            environmentLabel={environmentLabel}
            onInstall={() => void install(option)}
            onRefresh={() => void refresh(option.instanceId)}
            onSignIn={() => setSigningIn(option)}
          />
        ))}
      </ul>
      {pendingCount > 0 ? (
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          You can finish this later in Settings → Providers.
        </p>
      ) : null}
      <div className="sticky bottom-0 -mx-5 mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-background/95 px-5 py-4 backdrop-blur-sm sm:-mx-8 sm:px-8">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeftIcon aria-hidden className="size-4" /> Back
        </Button>
        <Button onClick={onFinish}>{pendingCount > 0 ? "Finish later" : "Done"}</Button>
      </div>
      {signingIn && environmentId ? (
        <ProviderSettingsAuthDialog
          key={signingIn.instanceId}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          instanceId={signingIn.instanceId}
          displayName={signingIn.definition.label}
          provider={signingIn.provider}
          onClose={() => {
            const instanceId = signingIn.instanceId;
            setSigningIn(null);
            void refresh(instanceId);
          }}
        />
      ) : null}
    </>
  );
}

function ProviderSignInRow({
  option,
  need,
  busy,
  environmentLabel,
  onInstall,
  onRefresh,
  onSignIn,
}: {
  readonly option: ProviderSetupOption;
  readonly need: ProviderSetupNeed;
  readonly busy: boolean;
  readonly environmentLabel: string;
  readonly onInstall: () => void;
  readonly onRefresh: () => void;
  readonly onSignIn: () => void;
}) {
  const label = option.definition.label;
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (error) =>
      toastManager.add({ type: "error", title: "Could not copy", description: error.message }),
  });
  const checkAgain = (
    <Button variant="ghost" size="sm" disabled={busy} onClick={onRefresh}>
      <RefreshCwIcon aria-hidden className={cn("size-3.5", busy && "animate-spin")} />
      Check again
    </Button>
  );
  const copyButton = (command: string) => (
    <Button variant="outline" size="sm" onClick={() => copyToClipboard(command)}>
      {isCopied ? (
        <CheckIcon aria-hidden className="size-3.5" />
      ) : (
        <CopyIcon aria-hidden className="size-3.5" />
      )}
      {isCopied ? "Copied" : "Copy command"}
    </Button>
  );

  let detail: ReactNode;
  let actions: ReactNode = null;
  switch (need.kind) {
    case "checking":
      detail = (
        <span className="inline-flex items-center gap-1.5">
          <Spinner className="size-3" /> Checking {environmentLabel}…
        </span>
      );
      break;
    case "installing":
      detail = (
        <span className="inline-flex items-center gap-1.5">
          <Spinner className="size-3" /> Installing…
        </span>
      );
      break;
    case "ready":
      detail = (
        <span className="inline-flex items-center gap-1.5 text-success-foreground">
          <CheckIcon aria-hidden className="size-3.5" />
          {need.account ? `Signed in as ${need.account}` : "Ready"}
        </span>
      );
      break;
    case "install":
      detail =
        need.error ??
        (need.canInstall
          ? `Not installed on ${environmentLabel}.`
          : need.command
            ? `Not installed. Run this command in a terminal on ${environmentLabel}, then check again: ${need.command}`
            : `Not installed. Install ${label} on ${environmentLabel}, then check again.`);
      actions = need.canInstall ? (
        <Button size="sm" disabled={busy} onClick={onInstall}>
          <DownloadIcon aria-hidden className="size-3.5" />
          Install
        </Button>
      ) : (
        <>
          {need.command ? copyButton(need.command) : null}
          {checkAgain}
        </>
      );
      break;
    case "sign-in-in-app":
      detail = "Not signed in.";
      actions = (
        <Button size="sm" disabled={busy} onClick={onSignIn}>
          <LogInIcon aria-hidden className="size-3.5" />
          Sign in
        </Button>
      );
      break;
    case "sign-in-terminal":
      detail = (
        <>
          Sign in by running{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
            {need.command}
          </code>{" "}
          in a terminal on {environmentLabel}.
        </>
      );
      actions = (
        <>
          {copyButton(need.command)}
          {checkAgain}
        </>
      );
      break;
    case "sign-in-settings":
      detail = `Sign in to ${label} from Settings → Providers.`;
      actions = (
        <Button variant="outline" size="sm" render={<Link to="/settings/providers" />}>
          Open Settings
        </Button>
      );
      break;
    case "attention":
      detail = need.detail;
      actions = checkAgain;
      break;
  }

  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <ProviderIcon option={option} />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p
            role={need.kind === "install" && need.error ? "alert" : undefined}
            className={cn(
              "mt-0.5 text-xs leading-relaxed break-words",
              need.kind === "install" && need.error ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {detail}
          </p>
        </div>
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
      ) : null}
    </li>
  );
}
