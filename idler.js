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

// User data lives in %APPDATA%/MonkeyIdler so it survives updates
const dataDir = path.join(app.getPath("appData"), "MonkeyIdler");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
global.dataDir = dataDir;

// Migrate user data from old install directory to AppData
// Copy if AppData version doesn't exist, or if install-dir version is newer (user edited it before update)
const migrateFiles = ["config.json", "accounts.txt", "proxies.txt", "playtime.txt", "output.txt"];
for (const file of migrateFiles) {
    const oldPath = path.join(appRoot, file);
    const newPath = path.join(dataDir, file);
    if (!fs.existsSync(oldPath)) continue;
    try {
        if (!fs.existsSync(newPath)) {
            fs.copyFileSync(oldPath, newPath);
        } else {
            const oldStat = fs.statSync(oldPath);
            const newStat = fs.statSync(newPath);
            if (oldStat.mtimeMs > newStat.mtimeMs && oldStat.size > 0) {
                fs.copyFileSync(oldPath, newPath);
            }
        }
    } catch (e) { /* ignore */ }
}
// Migrate tokens.db from old locations
const oldTokenPaths = [path.join(appRoot, "src", "tokens.db"), path.join(appRoot, "tokens.db")];
const newTokenPath = path.join(dataDir, "tokens.db");
if (!fs.existsSync(newTokenPath)) {
    for (const old of oldTokenPaths) {
        if (fs.existsSync(old)) {
            try { fs.copyFileSync(old, newTokenPath); break; } catch (e) { /* ignore */ }
        }
    }
}

// Ensure essential files exist (first run after install)
const defaults = {
    "config.json": JSON.stringify({ playingGames: [], onlinestatus: 1, afkMessage: "", relogTimeout: 15, useLocalIP: true, accountSettings: {} }, null, 4),
    "accounts.txt": "",
    "proxies.txt": ""
};
for (const [file, content] of Object.entries(defaults)) {
    const filePath = path.join(dataDir, file);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content, "utf8");
}

// Encrypt sensitive data files (migrates plaintext to encrypted on first run)
const { migrateFile } = require("./src/dataCrypt.js");
["config.json", "accounts.txt"].forEach(f => {
    try { migrateFile(path.join(dataDir, f)); } catch (e) { /* ignore */ }
});

const { startServer }        = require("./src/web/server.js");
const controller = require("./src/controller.js");
controller.isRunning = false;
controller.allBots.length = 0;

let mainWindow;
let serverPort;

function notifyUpdateStatus(payload) {
    try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update-status", payload);
    } catch (e) { /* ignore */ }
}

function runUpdateCheck() {
    if (!app.isPackaged) {
        console.log("[updater] Skipped: not a packaged build (dev / npm start).");
        notifyUpdateStatus({
            status: "dev-mode",
            message: "Automatic updates only work in the installed .exe from GitHub releases (not when running from source / npm start)."
        });
        return Promise.resolve();
    }
    return autoUpdater.checkForUpdates().catch((err) => {
        console.error("[updater] checkForUpdates failed:", err);
        notifyUpdateStatus({ status: "error", error: err?.message || String(err) });
    });
}

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

    // Auto-updater: packaged installs only (not `npm start`).
    // Use generic feed (latest.yml under /releases/latest/download/) — avoids GitHub Atom feed quirks in Electron.
    // Full differential downloads often break against GitHub; force full installer fetch.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.logger = null;
    autoUpdater.setFeedURL({
        provider: "generic",
        url: "https://github.com/garyrekted-commits/MonkeyIdler-Source/releases/latest/download/"
    });

    autoUpdater.on("update-available", (info) => {
        notifyUpdateStatus({ status: "downloading", version: info.version });
    });

    autoUpdater.on("update-downloaded", (info) => {
        notifyUpdateStatus({ status: "ready", version: info.version });
    });

    autoUpdater.on("update-not-available", (info) => {
        notifyUpdateStatus({ status: "up-to-date", feedVersion: info?.version || "" });
    });

    autoUpdater.on("error", (err) => {
        console.error("[updater] error event:", err);
        notifyUpdateStatus({ status: "error", error: err?.message || String(err) });
    });

    mainWindow.webContents.once("did-finish-load", () => {
        runUpdateCheck();
    });
});

// Window controls
ipcMain.handle("window-minimize", () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle("window-maximize", () => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); } });
ipcMain.handle("window-close", () => { if (mainWindow) mainWindow.close(); });

// Auto-updater controls
ipcMain.handle("check-for-update", () => { runUpdateCheck(); });
ipcMain.handle("install-update", () => {
    setImmediate(() => {
        app.removeAllListeners("window-all-closed");
        if (mainWindow) {
            mainWindow.removeAllListeners("close");
            mainWindow.close();
        }
        autoUpdater.quitAndInstall(false, true);
    });
});

// Open an authenticated Steam profile browser window (reuse a single partition)
let profileSession = null;
ipcMain.handle("open-steam-profile", async (event, { cookies, url }) => {
    if (!profileSession) profileSession = session.fromPartition("steam-profile");
    await profileSession.clearStorageData();
    for (const cookieStr of cookies) {
        const [nameVal] = cookieStr.split(";");
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
