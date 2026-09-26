// @vitest-environment happy-dom
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as PreviewManager from "./Manager.ts";
import { playwrightInjectedRuntimeInstallExpression } from "./PlaywrightInjectedRuntime.ts";

interface InjectedScript {
  readonly parseSelector: (selector: string) => unknown;
  readonly querySelector: (
    selector: unknown,
    root: unknown,
    strict: boolean,
  ) => Element | undefined;
}

// The real Playwright runtime the desktop injects, querying a same-origin
// iframe's document the way the edit target resolver hands it one. (Role
// locators need layout, which happy-dom lacks, so they are not exercised.)
it.effect("finds fields inside a same-origin iframe with the injected Playwright runtime", () =>
  Effect.gen(function* () {
    const install = yield* playwrightInjectedRuntimeInstallExpression();
    new Function(install)();
    const injected = (globalThis as { __t3PlaywrightInjected?: InjectedScript })
      .__t3PlaywrightInjected;
    assert.isDefined(injected);
    document.body.innerHTML = `<input id="email"><iframe id="rp-pay"></iframe>`;
    const frame = document.getElementById("rp-pay");
    const inner = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
    assert.isNotNull(inner);
    inner!.body.innerHTML = `<label for="pin">Enter your PIN</label><input id="pin" type="password">`;

    const resolve = new Function(`return ${PreviewManager.PREVIEW_EDIT_TARGET_JS};`)() as (
      target: unknown,
      query: (part: string, root: unknown) => Element | undefined,
    ) => { readonly element?: Element };
    const found = (locator: string) =>
      resolve({ kind: "locator", parts: PreviewManager.splitFrameLocator(locator) }, (part, root) =>
        injected!.querySelector(injected!.parseSelector(part), root, true),
      ).element?.id;

    assert.strictEqual(found('iframe[id="rp-pay"] >> internal:control=enter-frame >> #pin'), "pin");
    assert.strictEqual(found("#pin"), "pin");
    assert.strictEqual(found('internal:label="Enter your PIN"i'), "pin");
    // The page's own field still wins over a frame's.
    assert.strictEqual(found("input"), "email");
  }),
);
