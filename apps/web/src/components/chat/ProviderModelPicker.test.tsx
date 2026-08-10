import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
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
      <ModelPickerSidebar
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
