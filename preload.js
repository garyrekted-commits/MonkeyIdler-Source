const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    openSteamProfile: (data) => ipcRenderer.invoke("open-steam-profile", data),
    openSteamPointsShop: (data) => ipcRenderer.invoke("open-steam-points-shop", data),
    minimizeWindow: () => ipcRenderer.invoke("window-minimize"),
    maximizeWindow: () => ipcRenderer.invoke("window-maximize"),
    closeWindow: () => ipcRenderer.invoke("window-close"),
    checkForUpdate: () => ipcRenderer.invoke("check-for-update"),
    installUpdate: () => ipcRenderer.invoke("install-update"),
    onUpdateStatus: (callback) => ipcRenderer.on("update-status", (event, data) => callback(data))
});
