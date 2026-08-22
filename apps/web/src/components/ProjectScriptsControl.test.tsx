import { AsyncResult } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import ProjectScriptsControl, { refreshFileScriptsForMenu } from "./ProjectScriptsControl";

const unusedAction = async () => AsyncResult.success(undefined);

describe("ProjectScriptsControl", () => {
  it("keeps a lightning-bolt Actions dropdown available before t3.json imports load", () => {
    const markup = renderToStaticMarkup(
      <ProjectScriptsControl
        scripts={[]}
        fileScripts={[]}
        keybindings={[]}
        onRefreshFileScripts={vi.fn()}
        onRunScript={vi.fn()}
        onAddScript={unusedAction}
        onUpdateScript={unusedAction}
        onDeleteScript={unusedAction}
      />,
    );

    expect(markup).toContain('aria-label="Actions"');
    expect(markup).toContain("lucide-zap");
    expect(markup).toContain(">Actions</span>");
    expect(markup).not.toContain('aria-label="Add action"');
  });

  it("refreshes t3.json only when an actions menu opens", () => {
    const refresh = vi.fn();

    refreshFileScriptsForMenu(false, refresh);
    expect(refresh).not.toHaveBeenCalled();

    refreshFileScriptsForMenu(true, refresh);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
