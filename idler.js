/*
 * File: idler.js
 * Project: steam-idler
 * Created Date: 2021-03-31 21:05:47
 * Author: 3urobeat
 *
 * Last Modified: 2023-12-29 18:18:56
 * Modified By: 3urobeat
 *
 * Copyright (c) 2022 - 2023 3urobeat <https://github.com/3urobeat>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 * You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
 */


// Launch the web dashboard server and open the Electron desktop window
const { app, BrowserWindow, ipcMain, session } = require("electron");
const { autoUpdater }        = require("electron-updater");
const path                   = require("path");
const fs                     = require("fs");

// Set working directory to where the app files live so relative paths work when installed
const appRoot = path.dirname(__dirname.includes("app.asar") ? process.execPath : __filename);
process.chdir(app.isPackaged ? appRoot : __dirname);

// Ensure essential files exist (first run after install)
const defaults = {
    "config.json": JSON.stringify({ playingGames: [], onlinestatus: 1, afkMessage: "", relogTimeout: 15, useLocalIP: true, accountSettings: {} }, null, 4),
    "accounts.txt": "",
    "proxies.txt": ""
};
for (const [file, content] of Object.entries(defaults)) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, content, "utf8");
}

const { startServer }        = require("./src/web/server.js");
const controller = require("./src/controller.js");
controller.isRunning = false;
controller.allBots.length = 0;

let mainWindow;
let serverPort;

app.whenReady().then(async () => {
    serverPort = await startServer();

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: "Monkey Idler",
        icon: path.join(__dirname, "icon.ico"),
        autoHideMenuBar: true,
        transparent: true,
        frame: false,
        backgroundColor: "#00000000",
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js")
        }
    });

    mainWindow.loadURL(`http://localhost:${serverPort}`);
    mainWindow.on("closed", () => { mainWindow = null; });

    // Auto-updater: check for updates once the window is ready
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;

    autoUpdater.on("update-available", (info) => {
        if (mainWindow) mainWindow.webContents.send("update-status", { status: "downloading", version: info.version });
    });

    autoUpdater.on("update-downloaded", (info) => {
        if (mainWindow) mainWindow.webContents.send("update-status", { status: "ready", version: info.version });
    });

    autoUpdater.on("update-not-available", () => {
        if (mainWindow) mainWindow.webContents.send("update-status", { status: "up-to-date" });
    });

    autoUpdater.on("error", (err) => {
        if (mainWindow) mainWindow.webContents.send("update-status", { status: "error", error: err?.message || String(err) });
    });

    autoUpdater.checkForUpdates().catch(() => {});
});

// Window controls
ipcMain.handle("window-minimize", () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle("window-maximize", () => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); } });
ipcMain.handle("window-close", () => { if (mainWindow) mainWindow.close(); });

// Auto-updater controls
ipcMain.handle("check-for-update", () => { autoUpdater.checkForUpdates().catch(() => {}); });
ipcMain.handle("install-update", () => { autoUpdater.quitAndInstall(false, true); });

// Open an authenticated Steam profile browser window
ipcMain.handle("open-steam-profile", async (event, { cookies, url }) => {
    const profileSession = session.fromPartition("steam-profile-" + Date.now());
    for (const cookieStr of cookies) {
        const [nameVal, ...rest] = cookieStr.split(";");
        const [name, ...valParts] = nameVal.split("=");
        const value = valParts.join("=");
        await profileSession.cookies.set({
            url: "https://steamcommunity.com",
            name: name.trim(),
            value: value,
            domain: ".steamcommunity.com",
            path: "/",
            secure: name.trim().toLowerCase().includes("secure"),
            httpOnly: true
        });
    }
    const win = new BrowserWindow({
        width: 1100,
        height: 750,
        title: "Steam Profile",
        icon: path.join(__dirname, "icon.ico"),
        autoHideMenuBar: true,
        webPreferences: { session: profileSession, nodeIntegration: false, contextIsolation: true }
    });
    win.loadURL(url);
});

app.on("window-all-closed", () => {
    try { if (controller.isRunning) controller.stop(); } catch (e) { /* ignore */ }
    app.quit();
});
