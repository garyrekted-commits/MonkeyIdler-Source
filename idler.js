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
const { app, BrowserWindow, ipcMain, session, Tray, Menu } = require("electron");
const { autoUpdater }        = require("electron-updater");
const path                   = require("path");
const fs                     = require("fs");
const https                  = require("https");

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
    "config.json": JSON.stringify({ playingGames: [], onlinestatus: 1, afkMessage: "", loginDelay: 2000, relogDelay: 15000, useLocalIP: true, logPlaytimeToFile: true, accountSettings: {} }, null, 4),
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

// Always sync bundled dashboard background into AppData (correct mime + no stale cache)
function ensureAppBackground() {
    const webDir = path.join(__dirname, "src", "web");
    const names = ["bg.webp", "bg.png"];
    try {
        for (const name of names) {
            const bundled = path.join(webDir, name);
            if (!fs.existsSync(bundled)) continue;
            fs.copyFileSync(bundled, path.join(dataDir, name));
        }
        const oldGif = path.join(dataDir, "bg.gif");
        if (fs.existsSync(oldGif)) fs.unlinkSync(oldGif);
    } catch (e) { /* ignore */ }
}
const { startServer }        = require("./src/web/server.js");
const controller = require("./src/controller.js");
controller.isRunning = false;
controller.allBots.length = 0;

// electron-updater compares app.getVersion() — keep display in sync
let appVersion = "";
try {
    appVersion = app.getVersion() || JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version || "";
} catch (e) { /* ignore */ }

const GITHUB_OWNER = "garyrekted-commits";
const GITHUB_REPO  = "MonkeyIdler-Source";

function fetchLatestReleaseMeta() {
    return new Promise((resolve) => {
        const opts = {
            hostname: "api.github.com",
            path: "/repos/" + GITHUB_OWNER + "/" + GITHUB_REPO + "/releases/latest",
            headers: {
                "User-Agent": "MonkeyIdler",
                Accept: "application/vnd.github+json"
            }
        };
        https.get(opts, (res) => {
            let body = "";
            res.on("data", (c) => { body += c; });
            res.on("end", () => {
                if (res.statusCode !== 200) {
                    resolve({ ok: false, error: "GitHub API HTTP " + res.statusCode });
                    return;
                }
                try {
                    const j = JSON.parse(body);
                    const setup = (j.assets || []).find((a) => a.name === "MonkeyIdler-Setup.exe");
                    resolve({
                        ok: true,
                        tag: j.tag_name || "",
                        name: j.name || "",
                        htmlUrl: j.html_url || "",
                        setupUrl: setup ? setup.browser_download_url : "",
                        body: j.body || ""
                    });
                } catch (e) {
                    resolve({ ok: false, error: e.message || String(e) });
                }
            });
        }).on("error", (err) => {
            resolve({ ok: false, error: err.message || String(err) });
        });
    });
}

let mainWindow;
let tray = null;
let isQuitting = false;
let serverPort;

function showMainWindow() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function hideMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function createTray() {
    const iconPath = path.join(__dirname, "icon.ico");
    if (!fs.existsSync(iconPath)) return;
    tray = new Tray(iconPath);
    tray.setToolTip(appVersion ? "Monkey Idler v" + appVersion : "Monkey Idler");
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: "Show Monkey Idler", click: showMainWindow },
        { type: "separator" },
        { label: "Quit", click: () => { isQuitting = true; app.quit(); } }
    ]));
    tray.on("double-click", showMainWindow);
}
/** True after electron-updater has downloaded an installer for this session (quitAndInstall is safe). */
let updateInstallerDownloaded = false;

function notifyUpdateStatus(payload) {
    try {
        const msg = { ...payload, currentVersion: app.getVersion() };
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update-status", msg);
    } catch (e) { /* ignore */ }
}

function runUpdateCheck() {
    if (!app.isPackaged) {
        console.log("[updater] Skipped: not a packaged build (dev / npm start).");
        notifyUpdateStatus({
            status: "dev-mode",
            message: "Automatic updates only work in the installed NSIS build from GitHub releases (not when running from source / npm start)."
        });
        return Promise.resolve();
    }
    // electron-builder portable sets this — NSIS auto-update does not apply
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
        console.log("[updater] Skipped: portable build (PORTABLE_EXECUTABLE_DIR).");
        notifyUpdateStatus({
            status: "portable-mode",
            message: "Portable .exe: in-app updates are not supported. Download MonkeyIdler-Setup.exe from GitHub Releases and install, or replace your portable file manually."
        });
        return Promise.resolve();
    }
    return autoUpdater.checkForUpdates().catch((err) => {
        console.error("[updater] checkForUpdates failed:", err);
        notifyUpdateStatus({ status: "error", error: err?.message || String(err) });
    });
}

app.whenReady().then(async () => {
    ensureAppBackground();
    serverPort = await startServer(path.join(__dirname, "src", "web"));

    try { await session.defaultSession.clearCache(); } catch (e) { /* ignore */ }

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: appVersion ? "Monkey Idler v" + appVersion : "Monkey Idler",
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

    mainWindow.loadURL(`http://localhost:${serverPort}/?t=${Date.now()}`);

    mainWindow.on("close", (e) => {
        if (!isQuitting) {
            e.preventDefault();
            hideMainWindow();
        }
    });
    mainWindow.on("closed", () => { mainWindow = null; });

    createTray();

    // Auto-updater: packaged NSIS installs only (not portable .exe / not `npm start`).
    // Generic /releases/latest/download/ avoids 404 when duplicate GitHub releases share the same tag.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.logger = null;
    autoUpdater.requestHeaders = { "User-Agent": "MonkeyIdler/electron-updater" };
    autoUpdater.setFeedURL({
        provider: "generic",
        url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download/`,
        useMultipleRangeRequest: false
    });

    autoUpdater.on("checking-for-update", () => {
        notifyUpdateStatus({ status: "checking" });
    });

    autoUpdater.on("update-available", (info) => {
        updateInstallerDownloaded = false;
        notifyUpdateStatus({
            status: "downloading",
            version: info.version,
            releaseNotes: info.releaseNotes || info.releaseName || ""
        });
    });

    autoUpdater.on("download-progress", (p) => {
        notifyUpdateStatus({
            status: "progress",
            percent: typeof p.percent === "number" ? Math.round(p.percent) : 0,
            transferred: p.transferred,
            total: p.total
        });
    });

    autoUpdater.on("update-downloaded", (info) => {
        updateInstallerDownloaded = true;
        notifyUpdateStatus({
            status: "ready",
            version: info.version,
            releaseNotes: info.releaseNotes || info.releaseName || ""
        });
    });

    autoUpdater.on("update-not-available", (info) => {
        updateInstallerDownloaded = false;
        notifyUpdateStatus({ status: "up-to-date", feedVersion: info?.version || "" });
    });

    autoUpdater.on("error", (err) => {
        console.error("[updater] error event:", err);
        updateInstallerDownloaded = false;
        notifyUpdateStatus({ status: "error", error: err?.message || String(err) });
    });

    mainWindow.webContents.once("did-finish-load", () => {
        runUpdateCheck();
    });
});

ipcMain.handle("get-app-version", () => appVersion);
ipcMain.handle("get-latest-release-meta", () => fetchLatestReleaseMeta());

// Window controls (minimize / close hide to system tray)
ipcMain.handle("window-minimize", () => hideMainWindow());
ipcMain.handle("window-maximize", () => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); } });
ipcMain.handle("window-close", () => hideMainWindow());
ipcMain.handle("window-show", () => showMainWindow());

app.on("before-quit", () => { isQuitting = true; });

// Auto-updater controls
ipcMain.handle("check-for-update", () => runUpdateCheck());

ipcMain.handle("install-update", () => {
    if (!app.isPackaged) {
        return Promise.resolve({ ok: false, reason: "not-packaged" });
    }
    if (!updateInstallerDownloaded) {
        return Promise.resolve({ ok: false, reason: "no-download" });
    }
    setImmediate(() => {
        app.removeAllListeners("window-all-closed");
        if (mainWindow) {
            mainWindow.removeAllListeners("close");
            mainWindow.close();
        }
        autoUpdater.quitAndInstall(false, true);
    });
    return Promise.resolve({ ok: true });
});

// Apply Steam webSession cookies to both community and store (Points Shop lives on store.steampowered.com).
async function applySteamWebCookies(ses, cookies) {
    if (!Array.isArray(cookies)) return;
    for (const raw of cookies) {
        if (!raw || typeof raw !== "string") continue;
        const firstPart = raw.split(";")[0].trim();
        const eq = firstPart.indexOf("=");
        if (eq <= 0) continue;
        const name = firstPart.slice(0, eq).trim();
        const value = firstPart.slice(eq + 1).trim();
        if (!name) continue;
        const base = { name, value, path: "/", secure: true, sameSite: "no_restriction" };
        const targets = [
            { url: "https://steamcommunity.com", domain: ".steamcommunity.com" },
            { url: "https://store.steampowered.com", domain: ".steampowered.com" }
        ];
        for (const t of targets) {
            try {
                await ses.cookies.set({ ...base, ...t, httpOnly: true });
            } catch (e) { /* ignore per-host cookie rejects */ }
        }
    }
}

// Open an authenticated Steam profile browser window (reuse a single partition)
let profileSession = null;
ipcMain.handle("open-steam-profile", async (event, { cookies, url }) => {
    if (!profileSession) profileSession = session.fromPartition("steam-profile");
    await profileSession.clearStorageData();
    await applySteamWebCookies(profileSession, cookies);
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

const STEAM_POINTS_SHOP_URL = "https://store.steampowered.com/points/shop/";
let pointsShopSession = null;
ipcMain.handle("open-steam-points-shop", async (event, { cookies, accountName }) => {
    if (!pointsShopSession) pointsShopSession = session.fromPartition("steam-points-shop");
    await pointsShopSession.clearStorageData();
    await applySteamWebCookies(pointsShopSession, cookies);
    const title = accountName ? `Steam Points Shop — ${accountName}` : "Steam Points Shop";
    const win = new BrowserWindow({
        width: 1180,
        height: 820,
        title,
        icon: path.join(__dirname, "icon.ico"),
        autoHideMenuBar: true,
        webPreferences: { session: pointsShopSession, nodeIntegration: false, contextIsolation: true }
    });
    win.loadURL(STEAM_POINTS_SHOP_URL);
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && !tray) {
        try { if (controller.isRunning) controller.stop(); } catch (e) { /* ignore */ }
        app.quit();
    }
});
