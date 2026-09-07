"""Read-only repository inventory. Run from the repository root; JSON goes to stdout.

Includes tracked and nonignored untracked files. Excludes this audit's own output,
vendored references and nested worktrees. Heuristic flags are review leads, not bugs.
No dependencies, network calls, subprocess mutations, or application-state access.
"""

import collections
import datetime
import hashlib
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path.cwd()
SOURCE_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".swift", ".kt",
    ".java", ".rs", ".sh", ".ps1", ".py", ".css", ".astro",
}
PATTERNS = {
    "todo": r"\b(?:TODO|FIXME|HACK|XXX)\b",
    "unsafe": r"\bas any\b|@ts-ignore|@ts-nocheck|as unknown as",
    "empty_catch": r"catch\s*(?:\([^)]*\))?\s*\{\s*\}",
    "deprecated": r"@deprecated|\bDEPRECATED\b",
    "timer": r"Effect\.sleep|setTimeout\(",
    "suppression": r"(?:eslint|oxlint)-disable",
}


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT).decode()


def area_for(path):
    parts = path.split("/")
    if parts[0] in {"apps", "packages", "native", "tools", "experiments"}:
        return "/".join(parts[:2])
    return parts[0] if len(parts) > 1 else "(root)"


paths = sorted(set(git("ls-files", "-c", "-o", "--exclude-standard", "-z").split("\0")) - {""})
rows = []
flags = collections.defaultdict(list)
for path in paths:
    file = ROOT / path
    if not file.is_file() or file.is_symlink():
        continue
    if any(part in {".repos", "node_modules", ".claude"} for part in pathlib.PurePath(path).parts):
        continue
    if path.startswith("docs/project/codebase-cleanup-"):
        continue
    content = file.read_bytes()
    lines = content.decode("utf-8", errors="replace").splitlines()
    source = file.suffix in SOURCE_EXTENSIONS
    test = bool(re.search(r"\.test\.|\.spec\.|/test/|/tests/|/integration/", path))
    generated = bool(re.search(r"/_generated/|\.gen\.|\.generated\.|/vendor/|mockServiceWorker\.js$", path))
    rows.append({
        "path": path, "area": area_for(path), "bytes": len(content),
        "lines": len(lines), "source": source, "test_path": test,
        "generated_or_vendor": generated, "sha256": hashlib.sha256(content).hexdigest(),
    })
    if source:
        for number, line in enumerate(lines, 1):
            for kind, pattern in PATTERNS.items():
                if re.search(pattern, line):
                    flags[kind].append({"path": path, "line": number, "test_path": test,
                                        "generated_or_vendor": generated})

print(json.dumps({
    "captured_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "head": git("rev-parse", "HEAD").strip(),
    "branch": git("branch", "--show-current").strip(),
    "method": "git tracked plus nonignored untracked inventory; source suffix and textual pattern heuristics",
    "files": rows, "flags": flags,
}, indent=2))
