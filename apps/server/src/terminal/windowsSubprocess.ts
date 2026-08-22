import { agentCliCommandFromProcess, normalizeChildCommandName } from "./agentCliResume.ts";

/** Unit separator — CommandLine can contain `|` and spaces. */
export const WINDOWS_PROCESS_FIELD_SEP = "\u001f";

export interface WindowsCimProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  readonly commandLine: string;
}

export interface WindowsSubprocessInspectResult {
  readonly hasRunningSubprocess: boolean;
  readonly childCommand: string | null;
  readonly processIds: ReadonlyArray<number>;
  readonly processArgs: string | null;
}

export function windowsProcessSnapshotCommand(rootPids: readonly number[]): string {
  const roots = rootPids
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .map((pid) => String(pid));
  const rootList = roots.map((pid) => `[int]${pid}`).join(",");
  return `
$ErrorActionPreference = 'Stop'
$roots = @(${rootList})
if ($roots.Count -eq 0) { return }
$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
$byParent = @{}
foreach ($p in $all) {
  $pp = [int]$p.ParentProcessId
  if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = New-Object System.Collections.ArrayList }
  [void]$byParent[$pp].Add($p)
}
$stack = New-Object System.Collections.Stack
$seen = @{}
foreach ($root in $roots) {
  $rid = [int]$root
  if ($seen.ContainsKey($rid)) { continue }
  $stack.Push($rid)
  $seen[$rid] = $true
}
$sep = [char]31
while ($stack.Count -gt 0) {
  $parent = [int]$stack.Pop()
  if (-not $byParent.ContainsKey($parent)) { continue }
  foreach ($child in $byParent[$parent]) {
    $id = [int]$child.ProcessId
    if ($seen.ContainsKey($id)) { continue }
    $seen[$id] = $true
    $stack.Push($id)
    $name = [string]$child.Name
    $cmd = [string]$child.CommandLine
    if ($null -eq $cmd) { $cmd = '' }
    $cmd = (($cmd -replace '\\t',' ') -replace '\\r',' ') -replace '\\n',' '
    Write-Output ($id.ToString() + $sep + $parent.ToString() + $sep + $name + $sep + $cmd)
  }
}
`.trim();
}

export function parseWindowsCimProcessOutput(stdout: string): WindowsCimProcessRow[] {
  const rows: WindowsCimProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split(WINDOWS_PROCESS_FIELD_SEP);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const parentPid = Number(parts[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    rows.push({
      pid,
      parentPid,
      name: parts[2] ?? "",
      commandLine: parts.slice(3).join(WINDOWS_PROCESS_FIELD_SEP),
    });
  }
  return rows;
}

export function inspectWindowsSubprocessFromRows(
  terminalPid: number,
  rows: readonly WindowsCimProcessRow[],
): WindowsSubprocessInspectResult {
  if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
    return { hasRunningSubprocess: false, childCommand: null, processIds: [], processArgs: null };
  }
  const childrenByParent = new Map<number, WindowsCimProcessRow[]>();
  for (const row of rows) {
    const list = childrenByParent.get(row.parentPid) ?? [];
    list.push(row);
    childrenByParent.set(row.parentPid, list);
  }
  const directChildren = childrenByParent.get(terminalPid) ?? [];
  if (directChildren.length === 0) {
    return { hasRunningSubprocess: false, childCommand: null, processIds: [], processArgs: null };
  }

  const processIds = new Set<number>([terminalPid]);
  const pending = [terminalPid];
  const descendants: WindowsCimProcessRow[] = [];
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (parentPid === undefined) continue;
    for (const child of childrenByParent.get(parentPid) ?? []) {
      if (processIds.has(child.pid)) continue;
      processIds.add(child.pid);
      pending.push(child.pid);
      descendants.push(child);
    }
  }

  let agentCommand: string | null = null;
  let agentArgs: string | null = null;
  for (const row of descendants) {
    const detected = agentCliCommandFromProcess(
      normalizeChildCommandName(row.name),
      row.commandLine.length > 0 ? row.commandLine : null,
    );
    if (detected) {
      agentCommand = detected;
      agentArgs = row.commandLine.length > 0 ? row.commandLine : null;
      break;
    }
  }

  const firstChild = directChildren[0];
  const fallbackName = firstChild ? normalizeChildCommandName(firstChild.name) : null;
  const fallbackArgs =
    firstChild && firstChild.commandLine.length > 0 ? firstChild.commandLine : null;
  return {
    hasRunningSubprocess: true,
    childCommand: agentCommand ?? fallbackName,
    processIds: [...processIds],
    processArgs: agentArgs ?? fallbackArgs,
  };
}
