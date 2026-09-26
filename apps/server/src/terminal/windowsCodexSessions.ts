/** Read-only Restart Manager lookup: never requests shutdown or restart. */
export function windowsCodexSessionOwnersCommand(lockDirectory: string): string {
  const directory = `'${lockDirectory.replaceAll("'", "''")}'`;
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$directory = ${directory}
if (-not (Test-Path -LiteralPath $directory)) { Write-Output '[]'; return }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class SollaCodexFileOwners {
  [StructLayout(LayoutKind.Sequential)] public struct Process { public uint Id; public System.Runtime.InteropServices.ComTypes.FILETIME Start; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Info {
    public Process Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string Service;
    public uint Type, Status, Session;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, string key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint count, string[] files, uint apps, IntPtr processes, uint services, IntPtr names);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] Info[] info, ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  public static uint[] Read(string file) {
    uint handle;
    if (RmStartSession(out handle, 0, Guid.NewGuid().ToString("N")) != 0) return new uint[0];
    try {
      if (RmRegisterResources(handle, 1, new[] { file }, 0, IntPtr.Zero, 0, IntPtr.Zero) != 0) return new uint[0];
      uint needed, count=0, reasons=0;
      int result=RmGetList(handle, out needed, ref count, null, ref reasons);
      if (result != 234 || needed > 1024) return new uint[0];
      count=needed;
      Info[] entries=new Info[count];
      if (RmGetList(handle, out needed, ref count, entries, ref reasons) != 0) return new uint[0];
      uint[] ids=new uint[count];
      for (int i=0;i<count;i++) ids[i]=entries[i].Process.Id;
      return ids;
    } finally { RmEndSession(handle); }
  }
}
'@
$entries = @(Get-ChildItem -LiteralPath $directory -Filter '*.lock' -File | Where-Object { $_.BaseName -match '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' })
# Do not return a partial inventory, which could turn an ambiguous owner into a false match.
if ($entries.Count -gt 128) { Write-Output '[]'; return }
$result = @(foreach ($entry in $entries) {
  foreach ($owner in [SollaCodexFileOwners]::Read($entry.FullName)) {
    [pscustomobject]@{ pid=[int]$owner; sessionId=$entry.BaseName }
  }
})
ConvertTo-Json -InputObject $result -Compress
`.trim();
}

export interface CodexSessionOwner {
  readonly pid: number;
  readonly sessionId: string;
}

export function parseCodexSessionOwners(raw: string): ReadonlyArray<CodexSessionOwner> {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      return typeof record.pid === "number" &&
        Number.isInteger(record.pid) &&
        record.pid > 0 &&
        typeof record.sessionId === "string" &&
        /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(record.sessionId)
        ? [{ pid: record.pid, sessionId: record.sessionId }]
        : [];
    });
  } catch {
    return [];
  }
}

/** A shared backend or multiple sessions in one process must never guess a pane's identity. */
export function codexSessionForProcesses(
  owners: ReadonlyArray<CodexSessionOwner>,
  pids: ReadonlyArray<number>,
): string | null {
  const processIds = new Set(pids);
  const ids = new Set(
    owners.filter((owner) => processIds.has(owner.pid)).map((owner) => owner.sessionId),
  );
  return ids.size === 1 ? [...ids][0]! : null;
}
