// @vitest-environment happy-dom
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { TurnFileReference } from "@t3tools/client-runtime/state/turn-file-references";
import type { HostPathsExistRunner } from "../../hostPathExistence";
import { act } from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ResultFileReferences } from "./ResultFileReferences";

const { probe } = vi.hoisted(() => ({ probe: vi.fn<HostPathsExistRunner>() }));
vi.mock("../../state/filesystem", () => ({ filesystemEnvironment: { pathsExistNow: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => probe }));
vi.mock("../../assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Success", url: "/signed-media" }),
}));
vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));

let environmentNumber = 0;
const makeThreadRef = () => ({
  environmentId: EnvironmentId.make(`references-${++environmentNumber}`),
  threadId: ThreadId.make("thread-1"),
});
const reference = (path: string): TurnFileReference => ({
  path,
  name: path.split("/").at(-1)!,
  kind: "file",
});
const mounted: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  probe.mockReset();
  probe.mockImplementation(async ({ input }) =>
    AsyncResult.success({ entries: input.paths.map((path) => ({ path, kind: "file" })) }),
  );
});
afterEach(async () => {
  for (const cleanup of mounted.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, root };
}
async function answerHostProbe() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40);
  });
}

it("waits for host confirmation and excludes missing paths, directories, and web URLs", async () => {
  const { container, root } = mount();
  const threadRef = makeThreadRef();
  probe.mockImplementation(async ({ input }) =>
    AsyncResult.success({
      entries: input.paths.map((path) => ({
        path,
        kind: path.endsWith("real.ts")
          ? "file"
          : path.endsWith("folder.ts")
            ? "directory"
            : "missing",
      })),
    }),
  );
  await act(async () =>
    root.render(
      <ResultFileReferences
        standalone
        threadRef={threadRef}
        references={[
          "/work/real.ts",
          "/work/object.property",
          "/work/folder.ts",
          "https://example.com/remote.png",
        ].map(reference)}
      />,
    ),
  );
  expect(container.innerHTML).toBe("");
  await answerHostProbe();
  expect(probe.mock.calls[0]?.[0]).toEqual({
    environmentId: threadRef.environmentId,
    input: { paths: ["/work/real.ts", "/work/object.property", "/work/folder.ts"] },
  });
  expect(container.textContent).toContain("Referenced files · 1");
  expect(container.textContent).toContain("real.ts");
  expect(container.textContent).not.toMatch(/object.property|folder.ts|remote.png/);
  expect(container.querySelector('[data-result-summary="references"]')).not.toBeNull();
});

it("leaves no empty reference card when every path is missing or no environment is connected", async () => {
  const { container, root } = mount();
  probe.mockImplementation(async ({ input }) =>
    AsyncResult.success({ entries: input.paths.map((path) => ({ path, kind: "missing" })) }),
  );
  const references = [reference("/work/no.file")];
  await act(async () =>
    root.render(
      <ResultFileReferences standalone threadRef={makeThreadRef()} references={references} />,
    ),
  );
  await answerHostProbe();
  expect(container.innerHTML).toBe("");
  probe.mockClear();
  await act(async () =>
    root.render(<ResultFileReferences standalone threadRef={null} references={references} />),
  );
  await answerHostProbe();
  expect(container.innerHTML).toBe("");
  expect(probe).not.toHaveBeenCalled();
});

it("checks the owning environment again when the same path is viewed on another host", async () => {
  const { container, root } = mount();
  const references = [reference("C:/work/host-only.ts")];
  await act(async () =>
    root.render(<ResultFileReferences threadRef={makeThreadRef()} references={references} />),
  );
  await answerHostProbe();
  expect(container.textContent).toContain("host-only.ts");
  probe.mockImplementation(async ({ input }) =>
    AsyncResult.success({ entries: input.paths.map((path) => ({ path, kind: "missing" })) }),
  );
  await act(async () =>
    root.render(<ResultFileReferences threadRef={makeThreadRef()} references={references} />),
  );
  expect(container.innerHTML).toBe("");
  await answerHostProbe();
  expect(container.innerHTML).toBe("");
  expect(probe).toHaveBeenCalledTimes(2);
});

it("keeps verified media compact, previews on demand, and expands only verified references", async () => {
  const { container, root } = mount();
  await act(async () =>
    root.render(
      <ResultFileReferences
        threadRef={makeThreadRef()}
        references={Array.from({ length: 8 }, (_, i) => ({
          path: `/work/clip${i}.mp4`,
          name: `clip${i}.mp4`,
          kind: "video" as const,
        }))}
      />,
    ),
  );
  await answerHostProbe();
  expect(container.querySelectorAll('button[aria-label^="Preview"]')).toHaveLength(6);
  expect(document.querySelector("video")).toBeNull();
  await act(async () =>
    (
      container.querySelector('button[aria-label="Preview clip0.mp4"]') as HTMLButtonElement
    ).click(),
  );
  const video = document.querySelector("video");
  expect(video?.getAttribute("src")).toBe("/signed-media");
  expect(video?.controls).toBe(true);
  expect(video?.autoplay).toBe(false);
  await act(async () =>
    (document.querySelector('button[aria-label="Close preview"]') as HTMLButtonElement).click(),
  );
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((x) => x.textContent === "Show all 8 references")!
      .click(),
  );
  expect(container.querySelectorAll('button[aria-label^="Preview"]')).toHaveLength(8);
});
