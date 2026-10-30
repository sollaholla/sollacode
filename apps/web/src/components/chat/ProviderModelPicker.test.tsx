import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { Combobox, ComboboxListVirtualized } from "../ui/combobox";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerProviderTabs } from "./ModelPickerProviderTabs";
import { ProviderModelPicker } from "./ProviderModelPicker";

const instanceId = ProviderInstanceId.make("claudeAgent");
const model = {
  slug: "claude-opus-5",
  name: "Claude Opus 5",
  shortName: "Opus 5",
  isCustom: false,
  capabilities: null,
} as const;
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-03T12:00:00.000Z",
  models: [model],
  slashCommands: [],
  skills: [],
};

describe("ProviderModelPicker", () => {
  it("renders an intentional, accessible provider icon in icon-only mode", () => {
    const markup = renderToStaticMarkup(
      <ProviderModelPicker
        activeInstanceId={instanceId}
        model={model.slug}
        lockedProvider={null}
        instanceEntries={deriveProviderInstanceEntries([provider])}
        modelOptionsByInstance={new Map([[instanceId, [model]]])}
        iconOnly
        onInstanceModelChange={() => undefined}
      />,
    );

    expect(markup).toContain('data-chat-composer-control-display="icon"');
    expect(markup).toContain('aria-label="Choose model, currently Opus 5"');
    expect(markup.match(/<svg/gu)).toHaveLength(1);
  });

  it("keeps an installed provider button enabled when its startup probe fails", () => {
    const failedProvider: ServerProvider = {
      ...provider,
      status: "error",
      message: "Claude Agent CLI is installed but failed to run.",
    };
    const markup = renderToStaticMarkup(
      <ModelPickerProviderTabs
        selectedInstanceId="favorites"
        instanceEntries={deriveProviderInstanceEntries([failedProvider])}
        onSelectInstance={() => undefined}
      />,
    );
    const button = markup.match(/<button(?=[^>]*aria-label="Claude")[^>]*>/u)?.[0];

    expect(button).toBeDefined();
    expect(button).not.toContain("disabled");
  });
});

describe("ModelPickerProviderTabs", () => {
  it("labels every provider chip and marks the selected one", () => {
    const codex: ServerProvider = {
      ...provider,
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
    };
    const markup = renderToStaticMarkup(
      <ModelPickerProviderTabs
        selectedInstanceId={ProviderInstanceId.make("codex")}
        instanceEntries={deriveProviderInstanceEntries([provider, codex])}
        onSelectInstance={() => undefined}
      />,
    );

    expect(markup).toMatch(/<button(?=[^>]*aria-label="Favorites")(?=[^>]*aria-pressed="false")/u);
    expect(markup).toMatch(/<button(?=[^>]*aria-label="Claude")(?=[^>]*aria-pressed="false")/u);
    expect(markup).toMatch(/<button(?=[^>]*aria-label="Codex")(?=[^>]*aria-pressed="true")/u);
    expect(markup).toContain("<span>Claude</span>");
    expect(markup).toContain("<span>Codex</span>");
  });
});

describe("ModelListRow", () => {
  const renderRow = (overrides: Partial<Parameters<typeof ModelListRow>[0]> = {}) =>
    renderToStaticMarkup(
      <Combobox inline open items={[`${instanceId}:${model.slug}`]}>
        <ComboboxListVirtualized>
          <ModelListRow
            index={0}
            model={model}
            instanceId={instanceId}
            driverKind={provider.driver}
            providerDisplayName="Claude"
            isFavorite={false}
            isSelected={false}
            showProviderIcon={false}
            onToggleFavorite={() => undefined}
            {...overrides}
          />
        </ComboboxListVirtualized>
      </Combobox>,
    );

  it("keeps a single line without the provider name inside its own provider", () => {
    const markup = renderRow();

    expect(markup).toContain("Opus 5");
    expect(markup).not.toContain(">Claude<");
    expect(markup).toContain('aria-label="Add to favorites"');
    expect(markup).not.toContain("lucide-check");
  });

  it("marks the current model with a check", () => {
    expect(renderRow({ isSelected: true })).toContain("lucide-check");
  });

  it("names the instance in mixed lists only when asked", () => {
    expect(renderRow({ showProviderIcon: true, showProviderName: true })).toContain(">Claude<");
  });

  it("replaces the favorite toggle with a lock when the model is blocked", () => {
    const markup = renderRow({ disabledReason: "Blocked by model restrictions." });

    expect(markup).toContain("lucide-lock");
    expect(markup).not.toContain("Add to favorites");
  });
});
