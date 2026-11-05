import { describe, expect, it } from "vite-plus/test";

import { folderRemovalRefusal, trashCommand, trashNameFor } from "./ProjectFolderRemoval.ts";

const mac = {
  homeDir: "/Users/me",
  dataDir: "/Users/me/.solla-code",
  runningFrom: ["/Users/me", "/Applications/Solla Code.app/Contents/MacOS/Solla Code"],
  otherProjects: [],
  platform: "darwin" as const,
};
const windows = {
  homeDir: "C:\\Users\\me",
  dataDir: "C:\\Users\\me\\.solla-code",
  runningFrom: ["C:\\Users\\me\\AppData\\Local\\Programs\\solla-code\\Solla Code.exe"],
  otherProjects: [],
  platform: "win32" as const,
};
const linux = {
  homeDir: "/home/me",
  dataDir: "/home/me/.solla-code",
  runningFrom: ["/"],
  otherProjects: [],
  platform: "linux" as const,
};

describe("folderRemovalRefusal", () => {
  it("allows an ordinary project folder, wherever the server runs from", () => {
    for (const folder of ["/Users/me/Desktop/Acme", "/Users/me/code/acme", "/Users/me/acme"]) {
      expect(folderRemovalRefusal({ ...mac, folder })).toBeNull();
    }
    expect(folderRemovalRefusal({ ...windows, folder: "C:\\Users\\me\\code\\acme" })).toBeNull();
    expect(folderRemovalRefusal({ ...windows, folder: "D:\\Games\\Acme" })).toBeNull();
    expect(folderRemovalRefusal({ ...linux, folder: "/home/me/code/acme" })).toBeNull();
    expect(folderRemovalRefusal({ ...mac, folder: "/Volumes/Work/acme" })).toBeNull();
  });

  it("never takes a drive, a home folder, or anything around one", () => {
    for (const folder of ["/", "/Users", "/Users/me", "/USERS/ME"]) {
      expect(folderRemovalRefusal({ ...mac, folder })).not.toBeNull();
    }
    for (const folder of ["C:\\", "D:\\", "C:\\Users", "C:\\Users\\me", "c:\\users\\ME"]) {
      expect(folderRemovalRefusal({ ...windows, folder })).not.toBeNull();
    }
    expect(folderRemovalRefusal({ ...mac, folder: "/Volumes/Work" })).toBe(
      "This is a whole drive.",
    );
  });

  it("never takes a standard folder, but allows a project inside one", () => {
    for (const folder of ["Desktop", "Documents", "Downloads", "Pictures", ".ssh", ".config"]) {
      expect(folderRemovalRefusal({ ...mac, folder: `/Users/me/${folder}` })).not.toBeNull();
    }
    expect(folderRemovalRefusal({ ...linux, folder: "/home/me/Documents" })).not.toBeNull();
    expect(folderRemovalRefusal({ ...mac, folder: "/Users/me/Documents/acme" })).toBeNull();
    expect(folderRemovalRefusal({ ...mac, folder: "/Users/me/Library/Mail" })).not.toBeNull();
    expect(
      folderRemovalRefusal({ ...windows, folder: "C:\\Users\\me\\AppData\\Local\\Acme" }),
    ).not.toBeNull();
  });

  it("never takes a system folder", () => {
    for (const folder of ["/Applications", "/Applications/Acme.app", "/usr/local/acme", "/opt"]) {
      expect(folderRemovalRefusal({ ...mac, folder })).toBe("This is a system folder.");
    }
    for (const folder of ["C:\\Windows\\System32", "C:\\Program Files\\Acme"]) {
      expect(folderRemovalRefusal({ ...windows, folder })).toBe("This is a system folder.");
    }
  });

  it("never takes Solla Code's own data or the folder it runs from", () => {
    expect(folderRemovalRefusal({ ...mac, folder: "/Users/me/.solla-code/agents" })).not.toBeNull();
    const devServer = { ...mac, runningFrom: ["/Users/me/code/solla/apps/server"] };
    expect(folderRemovalRefusal({ ...devServer, folder: "/Users/me/code/solla" })).toBe(
      "This folder holds Solla Code itself or its data.",
    );
  });

  it("names another project that shares, sits inside, or surrounds the folder", () => {
    for (const workspaceRoot of [
      "/Users/me/code/acme",
      "/Users/me/code/acme/app",
      "/Users/me/code",
    ]) {
      expect(
        folderRemovalRefusal({
          ...mac,
          folder: "/Users/me/code/acme",
          otherProjects: [{ title: "Beta", workspaceRoot }],
        }),
      ).toBe("The project “Beta” uses this folder too.");
    }
    expect(
      folderRemovalRefusal({
        ...mac,
        folder: "/Users/me/code/acme",
        otherProjects: [{ title: "Sibling", workspaceRoot: "/Users/me/code/acme-two" }],
      }),
    ).toBeNull();
  });
});

describe("trashCommand", () => {
  it("uses the system's own Trash and never a delete", () => {
    expect(
      trashCommand({ platform: "darwin", folder: "/Users/me/acme", hasMacTrashTool: true }),
    ).toEqual({ command: "/usr/bin/trash", args: ["/Users/me/acme"] });
    expect(
      trashCommand({ platform: "darwin", folder: "/Users/me/acme", hasMacTrashTool: false })
        ?.command,
    ).toBe("/usr/bin/osascript");
    expect(trashCommand({ platform: "linux", folder: "/a", hasMacTrashTool: false })).toEqual({
      command: "gio",
      args: ["trash", "/a"],
    });
    expect(trashCommand({ platform: "freebsd", folder: "/a", hasMacTrashTool: false })).toBeNull();
  });

  it("escapes a Windows path so a quote can't break out of the script", () => {
    const command = trashCommand({
      platform: "win32",
      folder: "C:\\Users\\me\\it's here",
      hasMacTrashTool: false,
    });
    const script = Buffer.from(command?.args.at(-1) ?? "", "base64").toString("utf16le");
    expect(script).toContain("'C:\\Users\\me\\it''s here'");
    expect(script).toContain("SendToRecycleBin");
  });

  it("names the Trash the way each system does", () => {
    expect(trashNameFor("win32")).toBe("Recycle Bin");
    expect(trashNameFor("darwin")).toBe("Trash");
  });
});
