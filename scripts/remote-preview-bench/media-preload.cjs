const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("previewBenchMediaBridge", {
  videoSource: () => ipcRenderer.invoke("preview-bench-tab-source"),
  hostMediaUrl: (target) => ipcRenderer.invoke("preview-bench-host-media-url", target),
});
