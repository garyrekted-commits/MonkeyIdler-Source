const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    getAppVersion: () => ipcRenderer.invoke("get-app-version"),
    getLatestReleaseMeta: () => ipcRenderer.invoke("get-latest-release-meta"),
    openSteamProfile: (data) => ipcRenderer.invoke("open-steam-profile", data),
    minimizeWindow: () => ipcRenderer.invoke("window-minimize"),
    maximizeWindow: () => ipcRenderer.invoke("window-maximize"),
    closeWindow: () => ipcRenderer.invoke("window-close"),
    checkForUpdate: () => ipcRenderer.invoke("check-for-update"),
    installUpdate: () => ipcRenderer.invoke("install-update"),
    onUpdateStatus: (callback) => ipcRenderer.on("update-status", (event, data) => callback(data))
});
