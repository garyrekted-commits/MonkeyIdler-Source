/*
 * File: server.js
 * Project: steam-idler
 *
 * Express-based web server providing the dashboard UI and REST API.
 */

const fs      = require("fs");
const path    = require("path");
const express = require("express");

const dataDir      = global.dataDir || ".";
const { readSecure, writeSecure } = require("../dataCrypt.js");
const configPath   = path.join(dataDir, "config.json");
const accountsPath = path.join(dataDir, "accounts.txt");
const playtimePath = path.join(dataDir, "playtime.txt");

const app  = express();
const PORT = 3000;

app.use(express.json({ limit: "10mb" }));

// --- SSE log broadcasting ---

const sseClients = [];
const logBuffer  = []; // Ring buffer of recent log lines
const MAX_LOG_BUFFER = 500;

function broadcastLog(entry) {
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
    for (let i = sseClients.length - 1; i >= 0; i--) {
        try { sseClients[i].write(`data: ${JSON.stringify(entry)}\n\n`); }
        catch (e) { sseClients.splice(i, 1); }
    }
}

function broadcastStatus() {
    if (sseClients.length === 0) return;
    try {
        const controller = require("../controller.js");
        const status = controller.getAllStatus();
        for (let i = sseClients.length - 1; i >= 0; i--) {
            try { sseClients[i].write(`event: status\ndata: ${JSON.stringify(status)}\n\n`); }
            catch (e) { sseClients.splice(i, 1); }
        }
    } catch (e) { /* ignore */ }
}

// --- Chat relay ---
const chatBuffers = {}; // { username: [ { from, fromId, message, timestamp, outgoing } ] }
const MAX_CHAT_BUFFER = 100;
let chatSeq = 0;

function broadcastChat(username, entry) {
    if (!chatBuffers[username]) chatBuffers[username] = [];
    entry.seq = ++chatSeq;
    chatBuffers[username].push(entry);
    if (chatBuffers[username].length > MAX_CHAT_BUFFER) chatBuffers[username].shift();
}

// Expose for logger hook
module.exports.broadcastLog    = broadcastLog;
module.exports.broadcastStatus = broadcastStatus;
module.exports.broadcastChat   = broadcastChat;

// --- Pending Steam Guard code requests ---
const pendingCodes = {}; // { accountName: { callback, timer } }

function requestSteamGuardCode(accountName, callback) {
    pendingCodes[accountName] = { callback };
    // Notify all SSE clients that a code is needed
    for (const res of sseClients) {
        res.write(`event: steamguard\ndata: ${JSON.stringify({ account: accountName })}\n\n`);
    }
}

function hasPendingCode(accountName) {
    return !!pendingCodes[accountName];
}

function cancelPendingCode(accountName) {
    delete pendingCodes[accountName];
    // Notify dashboard to dismiss the modal
    for (const res of sseClients) {
        res.write(`event: steamguard_dismiss\ndata: ${JSON.stringify({ account: accountName })}\n\n`);
    }
}

module.exports.requestSteamGuardCode = requestSteamGuardCode;
module.exports.hasPendingCode        = hasPendingCode;
module.exports.cancelPendingCode     = cancelPendingCode;

// --- Helpers (with in-memory caching) ---

let _configCache = null;
let _accountsCache = null;

function loadConfig() {
    if (_configCache) return _configCache;
    if (!fs.existsSync(configPath)) {
        const defaults = { playingGames: [], onlinestatus: 1, afkMessage: "", loginDelay: 2000, relogDelay: 15000, useLocalIP: true, logPlaytimeToFile: true, accountSettings: {} };
        writeSecure(configPath, JSON.stringify(defaults, null, 4) + "\n");
        _configCache = defaults;
        return defaults;
    }
    _configCache = JSON.parse(readSecure(configPath));
    return _configCache;
}

function saveConfig(config) {
    writeSecure(configPath, JSON.stringify(config, null, 4) + "\n");
    _configCache = config;
}

function loadAccounts() {
    if (_accountsCache) return _accountsCache;
    if (!fs.existsSync(accountsPath)) return [];
    const lines = readSecure(accountsPath).split("\n");
    const accounts = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("//")) continue;
        const parts = line.split(":");
        accounts.push({ username: parts[0], password: parts[1] || "", sharedSecret: parts[2] || "" });
    }
    _accountsCache = accounts;
    return accounts;
}

function saveAccounts(accounts) {
    const header = "//Comment: Add all accounts to idle below, one per line: username:password:shared_secret  (shared_secret is optional)";
    const lines = accounts.map(a => {
        let line = `${a.username}:${a.password}`;
        if (a.sharedSecret) line += `:${a.sharedSecret}`;
        return line;
    });
    writeSecure(accountsPath, header + "\n" + lines.join("\n") + "\n");
    _accountsCache = accounts;
}

// --- Routes ---

// Invalidate server caches
app.post("/api/refresh", (req, res) => {
    _configCache = null;
    _accountsCache = null;
    _playtimeCache = null;
    _playtimeMtime = 0;
    res.json({ ok: true });
});

// Serve dashboard
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});
function detectImageMime(filePath) {
    try {
        const buf = Buffer.alloc(12);
        const fd = fs.openSync(filePath, "r");
        fs.readSync(fd, buf, 0, 12, 0);
        fs.closeSync(fd);
        if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
        if (buf[0] === 0xFF && buf[1] === 0xD8) return "image/jpeg";
        if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
        if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    } catch (e) { /* ignore */ }
    return "application/octet-stream";
}

function resolveAppBackground() {
    const names = ["bg.webp", "bg.png", "bg.gif", "bg.jpg", "bg.jpeg"];
    const dirs = [];
    if (global.dataDir) dirs.push(global.dataDir);
    if (bundledWebDir) dirs.push(bundledWebDir);
    dirs.push(__dirname);
    for (const dir of dirs) {
        for (const name of names) {
            const filePath = path.join(dir, name);
            if (fs.existsSync(filePath)) {
                return { filePath, mime: detectImageMime(filePath) };
            }
        }
    }
    return null;
}

function sendAppBackground(req, res) {
    const bg = resolveAppBackground();
    if (!bg) return res.status(404).end();
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
    res.type(bg.mime);
    res.sendFile(bg.filePath);
}

let embeddedBgDataUri = null;

function refreshEmbeddedBgDataUri() {
    const bg = resolveAppBackground();
    if (!bg) { embeddedBgDataUri = null; return; }
    try {
        embeddedBgDataUri = `data:${bg.mime};base64,${fs.readFileSync(bg.filePath).toString("base64")}`;
    } catch (e) {
        embeddedBgDataUri = null;
    }
}

app.get("/app-background", sendAppBackground);
app.get("/bg.png", sendAppBackground);
app.get("/bg.webp", sendAppBackground);
app.get("/bg.gif", sendAppBackground);
app.get("/bg-embedded.js", (req, res) => {
    if (!embeddedBgDataUri) refreshEmbeddedBgDataUri();
    res.set("Cache-Control", "no-store");
    res.type("application/javascript");
    res.send(`window.APP_BG_DATA_URI=${JSON.stringify(embeddedBgDataUri || "")};`);
});

// Same-origin assets (e.g. gif.js Web Worker — cross-origin worker URLs are blocked)
app.use("/vendor", express.static(path.join(__dirname, "vendor"), { maxAge: "7d" }));

// SSE endpoint for live logs + status
app.get("/api/logs", (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    });
    res.write(`data: ${JSON.stringify({ type: "init", logs: logBuffer })}\n\n`);
    sseClients.push(res);
    req.on("close", () => {
        const idx = sseClients.indexOf(res);
        if (idx !== -1) sseClients.splice(idx, 1);
    });
});

// Polling endpoint: returns logs since a given index + current status + pending steamguard
let qrLoginDone = null; // set to username when QR login completes
app.get("/api/poll", (req, res) => {
    const since = parseInt(req.query.since) || 0;
    const newLogs = logBuffer.slice(since);
    const controller = require("../controller.js");
    const status = controller.getAllStatus();
    const guard = Object.keys(pendingCodes);
    const result = { logs: newLogs, total: logBuffer.length, bots: status, isRunning: controller.isRunning, guard };
    if (qrLoginDone) { result.qrDone = qrLoginDone; qrLoginDone = null; }
    // Include new chat messages since last poll
    const chatSince = parseInt(req.query.chatSince) || 0;
    const chats = {};
    for (const [user, msgs] of Object.entries(chatBuffers)) {
        const fresh = msgs.filter(m => m.seq > chatSince);
        if (fresh.length) chats[user] = fresh;
    }
    result.chats = chats;
    result.chatSeq = chatSeq;
    res.json(result);
});
module.exports.setQrLoginDone = function(username) { qrLoginDone = username; };

// Accounts CRUD
app.get("/api/accounts", (req, res) => {
    const accounts = loadAccounts().map(a => ({
        username: a.username,
        hasPassword: !!a.password,
        hasSharedSecret: !!a.sharedSecret
    }));
    res.json(accounts);
});

app.post("/api/accounts", (req, res) => {
    const { username, password, sharedSecret } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password are required" });
    const accounts = loadAccounts();
    if (accounts.find(a => a.username === username)) return res.status(409).json({ error: "Account already exists" });
    accounts.push({ username, password, sharedSecret: sharedSecret || "" });
    saveAccounts(accounts);
    res.json({ ok: true });
});

app.delete("/api/accounts/:username", (req, res) => {
    const accounts = loadAccounts();
    const idx = accounts.findIndex(a => a.username === req.params.username);
    if (idx === -1) return res.status(404).json({ error: "Account not found" });
    accounts.splice(idx, 1);
    saveAccounts(accounts);
    // Also clean up per-account settings
    const config = loadConfig();
    if (config.accountSettings && config.accountSettings[req.params.username]) {
        delete config.accountSettings[req.params.username];
        saveConfig(config);
    }
    res.json({ ok: true });
});

// Config
app.get("/api/config", (req, res) => {
    res.json(loadConfig());
});

app.get("/api/changelog", (req, res) => {
    try {
        const filePath = path.join(bundledWebDir || __dirname, "changelog.json");
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: "Changelog not available", versions: [] });
    }
});

app.get("/api/ideas", (req, res) => {
    try {
        const filePath = path.join(bundledWebDir || __dirname, "ideas.json");
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: "Ideas list not available", categories: [] });
    }
});

app.put("/api/config", (req, res) => {
    const config = loadConfig();
    const allowed = ["playingGames", "onlinestatus", "afkMessage", "loginDelay", "relogDelay", "useLocalIP", "logPlaytimeToFile"];
    for (const key of allowed) {
        if (req.body[key] !== undefined) config[key] = req.body[key];
    }
    saveConfig(config);
    res.json({ ok: true });
});

app.put("/api/config/:username", (req, res) => {
    const config = loadConfig();
    if (!config.accountSettings) config.accountSettings = {};
    config.accountSettings[req.params.username] = req.body;
    saveConfig(config);
    res.json({ ok: true });
});

app.delete("/api/config/:username", (req, res) => {
    const config = loadConfig();
    if (config.accountSettings && config.accountSettings[req.params.username]) {
        delete config.accountSettings[req.params.username];
        saveConfig(config);
    }
    res.json({ ok: true });
});

// QR Code login for adding new accounts
const SteamSession = require("steam-session");
let activeQrSession = null;

app.post("/api/qrlogin", async (req, res) => {
    try {
        const session = new SteamSession.LoginSession(SteamSession.EAuthTokenPlatformType.SteamClient);
        activeQrSession = session;
        const startRes = await session.startWithQR();

        session.on("remoteInteraction", () => {
            broadcastLog({ type: "info", message: "QR code scanned! Waiting for confirmation...", timestamp: Date.now() });
        });

        session.on("authenticated", async () => {
            const accountName = session.accountName;
            broadcastLog({ type: "info", message: `QR login successful for ${accountName}!`, timestamp: Date.now() });

            // Add account to accounts.txt with "qrcode" as password
            const accounts = loadAccounts();
            if (!accounts.find(a => a.username === accountName)) {
                accounts.push({ username: accountName, password: "qrcode", sharedSecret: "" });
                saveAccounts(accounts);
            }

            // Store the refresh token in nedb
            const token = session.refreshToken;
            if (token) {
                try {
                    const nedb = require("@seald-io/nedb");
                    const db = new nedb({ filename: path.join(dataDir, "tokens.db"), autoload: true });
                    db.updateAsync({ accountName }, { $set: { token } }, { upsert: true });
                } catch (e) { broadcastLog({ type: "warn", message: "Could not save token: " + e.message, timestamp: Date.now() }); }
            }

            activeQrSession = null;
            module.exports.setQrLoginDone(accountName);
        });

        session.on("timeout", () => {
            activeQrSession = null;
            broadcastLog({ type: "warn", message: "QR login timed out.", timestamp: Date.now() });
        });

        session.on("error", (err) => {
            activeQrSession = null;
            broadcastLog({ type: "error", message: `QR login error: ${err}`, timestamp: Date.now() });
        });

        res.json({ ok: true, qrUrl: startRes.qrChallengeUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/qrlogin/cancel", (req, res) => {
    if (activeQrSession) {
        try { activeQrSession.cancelLoginAttempt(); } catch (e) {}
        activeQrSession = null;
    }
    res.json({ ok: true });
});

// Steam Guard code submission
app.post("/api/steamguard/:username", (req, res) => {
    const { code } = req.body;
    const username = req.params.username;
    const pending = pendingCodes[username];
    if (!pending) return res.status(404).json({ error: "No pending code request for this account" });
    delete pendingCodes[username];
    pending.callback(code || "");
    res.json({ ok: true });
});

// Get pending Steam Guard requests
app.get("/api/steamguard", (req, res) => {
    res.json(Object.keys(pendingCodes));
});

// Idling control
app.post("/api/start", async (req, res) => {
    const controller = require("../controller.js");
    if (controller.isRunning) return res.status(400).json({ error: "Already running" });
    const accounts = loadAccounts();
    if (accounts.length === 0) return res.status(400).json({ error: "No accounts configured" });
    controller.start();
    res.json({ ok: true });
});

app.post("/api/stop", (req, res) => {
    const controller = require("../controller.js");
    if (!controller.isRunning) return res.status(400).json({ error: "Not running" });
    controller.stop();
    res.json({ ok: true });
});

// Per-account start/stop
app.post("/api/accounts/:username/start", async (req, res) => {
    const controller = require("../controller.js");
    const ok = await controller.startOne(req.params.username);
    if (!ok) return res.status(400).json({ error: "Account not found or already running" });
    res.json({ ok: true });
});

app.post("/api/accounts/:username/stop", (req, res) => {
    const controller = require("../controller.js");
    const ok = controller.stopOne(req.params.username);
    if (!ok) return res.status(400).json({ error: "Account not found or not running" });
    res.json({ ok: true });
});

// Status
app.get("/api/status", (req, res) => {
    const controller = require("../controller.js");
    res.json({ isRunning: controller.isRunning, bots: controller.getAllStatus() });
});

// Owned games library for an account
app.get("/api/accounts/:username/games", (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot) return res.json({ games: [], idling: [], goals: {} });
    const idling = (bot.playedAppIDs || []).filter(g => typeof g === "number");
    const config = loadConfig();
    const acctCfg = (config.accountSettings && config.accountSettings[req.params.username]) || {};
    const goals = acctCfg.playtimeGoals || {};
    res.json({ games: bot.ownedGames || [], idling, goals });
});

// Playtime goals CRUD
app.get("/api/accounts/:username/goals", (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    const config = loadConfig();
    const acctCfg = (config.accountSettings && config.accountSettings[req.params.username]) || {};
    const goals = acctCfg.playtimeGoals || {};
    const progress = {};
    if (bot) {
        const sessionHours = bot.startedPlayingTimestamp > 0
            ? (Date.now() - bot.startedPlayingTimestamp) / 3600000
            : 0;
        for (const [appidStr, targetHours] of Object.entries(goals)) {
            const appid = parseInt(appidStr);
            const owned = (bot.ownedGames || []).find(g => g.appid === appid);
            const lifetimeMinutes = owned ? owned.playtimeForever : 0;
            const isIdling = (bot.playedAppIDs || []).includes(appid);
            const currentHours = (lifetimeMinutes / 60) + (isIdling ? sessionHours : 0);
            progress[appidStr] = { target: targetHours, current: Math.round(currentHours * 10) / 10 };
        }
    }
    res.json({ goals, progress });
});

app.put("/api/accounts/:username/goals", (req, res) => {
    const { appid, hours } = req.body;
    if (appid === undefined) return res.status(400).json({ error: "appid required" });
    const config = loadConfig();
    if (!config.accountSettings) config.accountSettings = {};
    const username = req.params.username;
    if (!config.accountSettings[username]) config.accountSettings[username] = {};
    if (!config.accountSettings[username].playtimeGoals) config.accountSettings[username].playtimeGoals = {};
    if (!hours || hours <= 0) {
        delete config.accountSettings[username].playtimeGoals[String(appid)];
    } else {
        config.accountSettings[username].playtimeGoals[String(appid)] = hours;
    }
    saveConfig(config);
    res.json({ ok: true, goals: config.accountSettings[username].playtimeGoals });
});

function getAccountPlayingGames(config, username, bot) {
    const acctCfg = (config.accountSettings && config.accountSettings[username]) || {};
    const fromCfg = acctCfg.playingGames ?? config.playingGames ?? [];
    const customs = fromCfg.filter(g => typeof g === "string");
    if (bot && bot.client.steamID) {
        const live = (bot.playedAppIDs || []).filter(g => typeof g === "number");
        return [...customs, ...live];
    }
    return [...fromCfg];
}

// Toggle games on/off the idle list (multiple games supported)
app.post("/api/accounts/:username/toggle", (req, res) => {
    const { appid, mode } = req.body;
    if (!appid) return res.status(400).json({ error: "appid required" });
    const config = loadConfig();
    if (!config.accountSettings) config.accountSettings = {};
    const username = req.params.username;
    if (!config.accountSettings[username]) config.accountSettings[username] = {};
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === username);
    let games = getAccountPlayingGames(config, username, bot);
    const idx = games.indexOf(appid);
    if (mode === "select") {
        const customs = games.filter(g => typeof g !== "number");
        if (idx !== -1) games = games.filter(g => g !== appid);
        else games = [...customs, appid];
    } else {
        if (idx !== -1) games.splice(idx, 1);
        else games.push(appid);
    }
    config.accountSettings[username].playingGames = games;
    config.accountSettings[username].wasIdling = games.some(g => typeof g === "number");
    saveConfig(config);
    if (bot && bot.client.steamID) {
        bot.setGamesPlayed(games);
    }
    res.json({ ok: true, idling: games.filter(g => typeof g === "number") });
});

// Start idling the remembered games
app.post("/api/accounts/:username/startidle", (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    const config = loadConfig();
    const acctCfg = (config.accountSettings && config.accountSettings[req.params.username]) || {};
    const games = acctCfg.playingGames || config.playingGames || [];
    if (games.length === 0) return res.status(400).json({ error: "No games configured to idle" });
    bot.setGamesPlayed(games);
    bot.startGoalCheck();
    if (!config.accountSettings) config.accountSettings = {};
    if (!config.accountSettings[req.params.username]) config.accountSettings[req.params.username] = {};
    config.accountSettings[req.params.username].wasIdling = true;
    saveConfig(config);
    res.json({ ok: true, idling: games });
});

// Stop idling but stay online (keeps games remembered in config)
app.post("/api/accounts/:username/stopidle", (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    bot.client.gamesPlayed([]);
    bot.playedAppIDs = [];
    const config = loadConfig();
    if (config.accountSettings && config.accountSettings[req.params.username]) {
        config.accountSettings[req.params.username].wasIdling = false;
        saveConfig(config);
    }
    res.json({ ok: true });
});

// Chat relay - send a message
app.post("/api/accounts/:username/chat", (req, res) => {
    const { steamId, message } = req.body;
    if (!steamId || !message) return res.status(400).json({ error: "steamId and message required" });
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    try {
        bot.client.chat.sendFriendMessage(steamId, message);
        const entry = { from: "You", fromId: null, message, timestamp: Date.now(), outgoing: true, toId: steamId };
        broadcastChat(req.params.username, entry);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/** Up to `limit` games for profile UI: last played time, then 2-week playtime, then total time. */
function pickRecentPlayedGames(bot, limit = 3) {
    const games = bot.ownedGames;
    if (!games || !games.length) return [];
    const seen = new Set();
    const out = [];
    const push = (g) => {
        if (out.length >= limit || seen.has(g.appid)) return;
        seen.add(g.appid);
        out.push({
            appid: g.appid,
            name: g.name,
            img: g.img,
            rtimeLastPlayed: g.rtimeLastPlayed || 0,
            playtimeForever: g.playtimeForever || 0,
            playtime2weeks: g.playtime2weeks || 0
        });
    };
    [...games].filter(g => (g.rtimeLastPlayed || 0) > 0)
        .sort((a, b) => (b.rtimeLastPlayed || 0) - (a.rtimeLastPlayed || 0))
        .forEach(push);
    if (out.length < limit) {
        [...games].filter(g => !seen.has(g.appid))
            .sort((a, b) => (b.playtime2weeks || 0) - (a.playtime2weeks || 0))
            .forEach(push);
    }
    if (out.length < limit) {
        [...games].filter(g => !seen.has(g.appid))
            .sort((a, b) => (b.playtimeForever || 0) - (a.playtimeForever || 0))
            .forEach(push);
    }
    return out.slice(0, limit);
}

// Profile info
app.get("/api/accounts/:username/profile", (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.json({ online: false });
    const sid64 = bot.client.steamID.getSteamID64();
    const me = bot.client.users[sid64] || {};
    res.json({
        online: true,
        steamId: sid64,
        name: me.player_name || req.params.username,
        avatar: me.avatar_url_full || me.avatar_url_medium || me.avatar_url_icon || "",
        state: me.persona_state || 0,
        stateName: ["Offline","Online","Busy","Away","Snooze","Looking to Trade","Looking to Play"][me.persona_state || 0] || "Offline",
        gameName: me.game_name || "",
        profileUrl: "https://steamcommunity.com/profiles/" + sid64,
        level: bot.steamLevel || 0,
        recentGames: pickRecentPlayedGames(bot, 3)
    });
});

// Steam deals - cached for 30 minutes
let dealsCache = {};
function steamFetch(url) {
    const https = require("https");
    const parsed = new URL(url);
    const opts = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: { "User-Agent": "MonkeyIdler/1.0" } };
    return new Promise((resolve, reject) => {
        https.get(opts, (r) => {
            let d = "";
            r.on("data", c => d += c);
            r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }).on("error", reject);
    });
}
app.get("/api/deals", async (req, res) => {
    const page = parseInt(req.query.page) || 0;
    const cacheKey = `page_${page}`;
    if (dealsCache[cacheKey] && Date.now() < dealsCache[cacheKey].expires) {
        return res.json(dealsCache[cacheKey].data);
    }
    try {
        const pageSize = 60;
        const url = `https://www.cheapshark.com/api/1.0/deals?storeID=1&onSale=1&pageSize=${pageSize}&pageNumber=${page}&sortBy=Savings&desc=0`;
        const raw = await steamFetch(url);
        const deals = raw.filter(g => g.steamAppID && g.steamAppID !== "0").map(g => ({
            name: g.title,
            appid: parseInt(g.steamAppID),
            image: `https://cdn.akamai.steamstatic.com/steam/apps/${g.steamAppID}/header.jpg`,
            originalPrice: Math.round(parseFloat(g.normalPrice) * 100),
            finalPrice: Math.round(parseFloat(g.salePrice) * 100),
            discountPercent: Math.round(parseFloat(g.savings)),
            metacritic: g.metacriticScore ? parseInt(g.metacriticScore) : null,
            rating: g.steamRatingPercent ? parseInt(g.steamRatingPercent) : null,
            dealID: g.dealID
        }));
        const result = { deals, page, hasMore: raw.length === pageSize };
        dealsCache[cacheKey] = { data: result, expires: Date.now() + 30 * 60 * 1000 };
        res.json(result);
    } catch (e) {
        console.error("Failed to fetch Steam deals:", e.message);
        res.status(500).json({ error: "Failed to fetch deals" });
    }
});

// Popular Steam deals (from Steam featured API)
let popularDealsCache = { data: null, expires: 0 };
app.get("/api/deals/popular", async (req, res) => {
    if (popularDealsCache.data && Date.now() < popularDealsCache.expires) {
        return res.json(popularDealsCache.data);
    }
    try {
        const body = await steamFetch("https://store.steampowered.com/api/featuredcategories?cc=us&l=english");
        const deals = [];
        const sections = ["specials", "top_sellers", "coming_soon", "new_releases"];
        for (const key of sections) {
            if (body[key] && body[key].items) {
                for (const item of body[key].items) {
                    if (!item.id || deals.some(d => d.appid === item.id)) continue;
                    const disc = item.discount_percent || 0;
                    if (disc <= 0 && key === "specials") continue;
                    deals.push({
                        name: item.name,
                        appid: item.id,
                        image: item.header_image || item.large_capsule_image || `https://cdn.akamai.steamstatic.com/steam/apps/${item.id}/header.jpg`,
                        originalPrice: item.original_price || 0,
                        finalPrice: item.final_price || 0,
                        discountPercent: disc,
                        section: key
                    });
                }
            }
        }
        const result = { deals };
        popularDealsCache = { data: result, expires: Date.now() + 30 * 60 * 1000 };
        res.json(result);
    } catch (e) {
        console.error("Failed to fetch popular deals:", e.message);
        res.status(500).json({ error: "Failed to fetch popular deals" });
    }
});

// Steam storefront default list (top sellers, new releases, etc.)
let storeFrontCache = { data: null, expires: 0 };
app.get("/api/deals/storefront", async (req, res) => {
    if (storeFrontCache.data && Date.now() < storeFrontCache.expires) {
        return res.json(storeFrontCache.data);
    }
    try {
        const body = await steamFetch("https://store.steampowered.com/api/featured?cc=us&l=english");
        const deals = [];
        if (body.featured_win) {
            for (const item of body.featured_win) {
                if (!item.id || deals.some(d => d.appid === item.id)) continue;
                deals.push({
                    name: item.name,
                    appid: item.id,
                    image: item.header_image || item.large_capsule_image || `https://cdn.akamai.steamstatic.com/steam/apps/${item.id}/header.jpg`,
                    originalPrice: item.original_price || item.final_price || 0,
                    finalPrice: item.final_price || 0,
                    discountPercent: item.discount_percent || 0
                });
            }
        }
        if (body.featured_mac) {
            for (const item of body.featured_mac) {
                if (!item.id || deals.some(d => d.appid === item.id)) continue;
                deals.push({
                    name: item.name,
                    appid: item.id,
                    image: item.header_image || item.large_capsule_image || `https://cdn.akamai.steamstatic.com/steam/apps/${item.id}/header.jpg`,
                    originalPrice: item.original_price || item.final_price || 0,
                    finalPrice: item.final_price || 0,
                    discountPercent: item.discount_percent || 0
                });
            }
        }
        const result = { deals };
        storeFrontCache = { data: result, expires: Date.now() + 30 * 60 * 1000 };
        res.json(result);
    } catch (e) {
        console.error("Failed to fetch storefront:", e.message);
        res.status(500).json({ error: "Failed to fetch storefront" });
    }
});

// Steam game details (cached 30 min)
const appDetailsCache = {};
app.get("/api/deals/:appid", async (req, res) => {
    const appid = req.params.appid;
    if (appDetailsCache[appid] && Date.now() < appDetailsCache[appid].expires) {
        return res.json(appDetailsCache[appid].data);
    }
    try {
        const body = await steamFetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=english`);
        const entry = body[appid];
        if (!entry || !entry.success) return res.status(404).json({ error: "Game not found" });
        const d = entry.data;
        const result = {
            name: d.name,
            appid: d.steam_appid,
            description: d.short_description || "",
            headerImage: d.header_image || "",
            screenshots: (d.screenshots || []).slice(0, 6).map(s => s.path_thumbnail),
            genres: (d.genres || []).map(g => g.description),
            developers: d.developers || [],
            publishers: d.publishers || [],
            releaseDate: d.release_date ? d.release_date.date : "",
            storeUrl: `https://store.steampowered.com/app/${appid}`,
            price: d.price_overview || null
        };
        appDetailsCache[appid] = { data: result, expires: Date.now() + 30 * 60 * 1000 };
        res.json(result);
    } catch (e) {
        console.error("Failed to fetch game details:", e.message);
        res.status(500).json({ error: "Failed to fetch game details" });
    }
});

// Refresh profile data (re-fetches Steam level)
app.post("/api/accounts/:username/refresh", async (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.json({ ok: false });
    try {
        const result = await bot.client.getSteamLevels([bot.client.steamID]);
        const sid64 = bot.client.steamID.getSteamID64();
        bot.steamLevel = (result && result.users && result.users[sid64]) || 0;
    } catch (e) { /* ignore */ }
    res.json({ ok: true, level: bot.steamLevel || 0 });
});

// Get web session cookies for authenticated browsing
app.get("/api/accounts/:username/websession", (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    if (!bot.webCookies) {
        bot.client.webLogOn();
        return res.status(202).json({ error: "Requesting web session, try again in a moment" });
    }
    const sid64 = bot.client.steamID.getSteamID64();
    res.json({ cookies: bot.webCookies, steamId: sid64 });
});

// Fetch profile comments via Steam's AJAX comment endpoint
app.get("/api/accounts/:username/profile/comments", async (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.json({ comments: [] });
    const sid64 = bot.client.steamID.getSteamID64();
    const start = parseInt(req.query.start) || 0;
    const count = Math.min(parseInt(req.query.count) || 20, 50);
    const https = require("https");
    try {
        const html = await new Promise((resolve, reject) => {
            https.get({
                hostname: "steamcommunity.com",
                path: `/comment/Profile/render/${sid64}/-1/?start=${start}&count=${count}`,
                headers: { "User-Agent": "Mozilla/5.0", Cookie: (bot.webCookies || []).join("; ") }
            }, (r) => {
                let d = "";
                r.on("data", c => d += c);
                r.on("end", () => resolve(d));
            }).on("error", reject);
        });
        const parsed = JSON.parse(html);
        const commentsHtml = parsed.comments_html || "";
        const comments = [];
        const blocks = commentsHtml.split(/class="commentthread_comment responsive_body_text/g);
        for (let i = 1; i < blocks.length; i++) {
            const b = blocks[i];
            const avMatch = b.match(/<img src="(https:\/\/avatars[^"]*?)"/);
            const nameMatch = b.match(/<bdi>(.*?)<\/bdi>/);
            const textMatch = b.match(/commentthread_comment_text"[^>]*>([\s\S]*?)<\/div>/);
            const timeMatch = b.match(/data-timestamp="(\d+)"/);
            if (nameMatch && textMatch) {
                comments.push({
                    author: nameMatch[1].trim(),
                    text: textMatch[1].replace(/<br\s*\/?>/g, "\n").replace(/<[^>]*>/g, "").trim(),
                    avatar: avMatch ? avMatch[1] : "",
                    timestamp: timeMatch ? parseInt(timeMatch[1]) * 1000 : 0
                });
            }
        }
        const total = parsed.total_count || comments.length;
        res.json({ comments, total, start, hasMore: (start + comments.length) < total });
    } catch (e) {
        res.json({ comments: [], error: e.message });
    }
});

// Post a comment on your own profile
app.post("/api/accounts/:username/profile/comments", async (req, res) => {
    const { comment } = req.body;
    if (!comment || !comment.trim()) return res.status(400).json({ error: "Comment text required" });
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    if (!bot.webCookies) {
        bot.client.webLogOn();
        return res.status(202).json({ error: "Requesting web session, try again in a moment" });
    }
    try {
        const result = await steamWebPost(bot, `https://steamcommunity.com/comment/Profile/post/${bot.client.steamID.getSteamID64()}/-1/`, {
            comment: comment.trim(),
            count: 10,
            feature2: -1
        });
        res.json({ ok: true, status: result.status });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Fetch user's Steam groups from profile page HTML
app.get("/api/accounts/:username/profile/groups", async (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.json({ groups: [] });
    const sid64 = bot.client.steamID.getSteamID64();
    const https = require("https");
    try {
        const html = await new Promise((resolve, reject) => {
            https.get({
                hostname: "steamcommunity.com",
                path: `/profiles/${sid64}`,
                headers: { "User-Agent": "Mozilla/5.0" }
            }, (r) => {
                let d = "";
                r.on("data", c => d += c);
                r.on("end", () => resolve(d));
            }).on("error", reject);
        });
        const groups = [];
        const blocks = html.split(/class="profile_group(?:\s+profile_primary_group)?"/g);
        for (let i = 1; i < blocks.length; i++) {
            const b = blocks[i];
            const avMatch = b.match(/<img src="(https:\/\/avatars[^"]*?)"/);
            const urlMatch = b.match(/href="(https:\/\/steamcommunity\.com\/groups\/[^"]*?)"/);
            const nameMatch = b.match(/whiteLink"[^>]*>([\s\S]*?)<\/a>/);
            const memberMatch = b.match(/profile_group_membercount">\s*([\d,]+)\s*Members/);
            if (nameMatch) {
                groups.push({
                    name: nameMatch[1].trim(),
                    url: urlMatch ? urlMatch[1] : "",
                    avatar: avMatch ? avMatch[1] : "",
                    members: memberMatch ? parseInt(memberMatch[1].replace(/,/g, "")) : 0
                });
            }
        }
        res.json({ groups });
    } catch (e) {
        res.json({ groups: [], error: e.message });
    }
});

// Edit display name
app.post("/api/accounts/:username/profile/name", (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Name required" });
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    bot.client.setPersona(bot.client.users[bot.client.steamID.getSteamID64()]?.persona_state || 1, name.trim());
    res.json({ ok: true });
});

// Set custom "currently playing" text
app.post("/api/accounts/:username/profile/customgame", (req, res) => {
    const { text } = req.body;
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    if (text && text.trim()) {
        bot.client.gamesPlayed([{ game_id: 0, game_extra_info: text.trim() }]);
    } else {
        const config = loadConfig();
        const acctCfg = (config.accountSettings && config.accountSettings[req.params.username]) || {};
        const games = acctCfg.playingGames || config.playingGames || [];
        bot.client.gamesPlayed(games);
    }
    res.json({ ok: true });
});

// Set avatar (accepts base64 PNG/JPG in body)
app.post("/api/accounts/:username/profile/avatar", (req, res) => {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    const buf = Buffer.from(imageBase64, "base64");
    bot.client.setAvatar(buf, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
    });
});

// Helper: make authenticated Steam community request using bot's web cookies
async function steamWebPost(bot, endpoint, formData) {
    const https = require("https");
    const sid64 = bot.client.steamID.getSteamID64();
    if (!bot.webCookies) throw new Error("No web session");
    const sessionId = bot.webCookies.find(c => c.startsWith("sessionid="))?.split("=")[1];
    if (!sessionId) throw new Error("No sessionid cookie");
    formData.sessionid = sessionId;
    formData.sessionID = sessionId;
    const body = Object.entries(formData).map(([k,v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v || "")).join("&");
    const cookieStr = bot.webCookies.join("; ");
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint.startsWith("http") ? endpoint : "https://steamcommunity.com/profiles/" + sid64 + "/" + endpoint);
        const req = https.request({ hostname: url.hostname, path: url.pathname, method: "POST", headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(body),
            "Cookie": cookieStr,
            "Referer": "https://steamcommunity.com/profiles/" + sid64 + "/edit/info"
        }}, (resp) => {
            let data = "";
            resp.on("data", c => data += c);
            resp.on("end", () => resolve({ status: resp.statusCode, data }));
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// Edit profile info (bio, real name, custom URL, country, etc.)
app.post("/api/accounts/:username/profile/edit", async (req, res) => {
    const { summary, realName, customURL, country, state, city } = req.body;
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    if (!bot.webCookies) {
        bot.client.webLogOn();
        return res.status(202).json({ error: "Requesting web session, try again in a moment" });
    }
    try {
        const formData = { type: "profileSave", json: "1" };
        if (summary !== undefined) formData.summary = summary;
        if (realName !== undefined) formData.real_name = realName;
        if (customURL !== undefined) formData.customURL = customURL;
        if (country !== undefined) formData.country = country;
        if (state !== undefined) formData.state = state;
        if (city !== undefined) formData.city = city;
        const result = await steamWebPost(bot, "edit", formData);
        res.json({ ok: true, status: result.status });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Edit privacy settings
app.post("/api/accounts/:username/profile/privacy", async (req, res) => {
    const { profile, gameDetails, playtime, friendsList, inventory, gifts, comments } = req.body;
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    if (!bot.webCookies) {
        bot.client.webLogOn();
        return res.status(202).json({ error: "Requesting web session, try again in a moment" });
    }
    try {
        const privacySettings = {
            PrivacyProfile: profile !== undefined ? profile : 3,
            PrivacyInventory: inventory !== undefined ? inventory : 3,
            PrivacyInventoryGifts: gifts !== undefined ? gifts : 3,
            PrivacyOwnedGames: gameDetails !== undefined ? gameDetails : 3,
            PrivacyPlaytime: playtime !== undefined ? playtime : 3,
            PrivacyFriendsList: friendsList !== undefined ? friendsList : 3
        };
        const formData = {
            type: "profileSave",
            json: "1",
            Privacy: JSON.stringify({ PrivacySettings: privacySettings, eCommentPermission: comments !== undefined ? comments : 2 })
        };
        const result = await steamWebPost(bot, "ajaxsetprivacy/", formData);
        res.json({ ok: true, status: result.status });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get current profile settings for editing
app.get("/api/accounts/:username/profile/settings", async (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.json({ online: false });
    if (!bot.webCookies) {
        bot.client.webLogOn();
        return res.status(202).json({ error: "Requesting web session" });
    }
    const https = require("https");
    const sid64 = bot.client.steamID.getSteamID64();
    const cookieStr = bot.webCookies.join("; ");
    try {
        const data = await new Promise((resolve, reject) => {
            https.get("https://steamcommunity.com/profiles/" + sid64 + "/edit/info", { headers: { Cookie: cookieStr } }, (resp) => {
                let d = "";
                resp.on("data", c => d += c);
                resp.on("end", () => resolve(d));
            }).on("error", reject);
        });
        const summary = (data.match(/id="summary"[^>]*>([\s\S]*?)<\/textarea/) || [])[1] || "";
        const realName = (data.match(/id="real_name"[^>]*value="([^"]*)"/) || [])[1] || "";
        const customURL = (data.match(/id="customURL"[^>]*value="([^"]*)"/) || [])[1] || "";
        res.json({ online: true, summary: summary.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#039;/g,"'").replace(/&quot;/g,'"'), realName, customURL });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Auto comment bot ---
const commentProgress = {}; // { username: { total, done, errors, running, log: [] } }

// Post a comment on a single profile
app.post("/api/accounts/:username/comment", async (req, res) => {
    const { targetSteamId, comment } = req.body;
    if (!targetSteamId || !comment) return res.status(400).json({ error: "targetSteamId and comment required" });
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    if (!bot.webCookies) { bot.client.webLogOn(); return res.status(202).json({ error: "Requesting web session, try again" }); }
    try {
        const result = await steamWebPost(bot, "https://steamcommunity.com/comment/Profile/post/" + targetSteamId + "/-1/", { comment });
        const parsed = JSON.parse(result.data);
        if (parsed.success) res.json({ ok: true });
        else res.status(400).json({ error: parsed.error || "Comment failed" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Bulk comment on all friends or selected friends
app.post("/api/accounts/:username/comment/bulk", async (req, res) => {
    const { comment, delay, steamIds } = req.body;
    if (!comment) return res.status(400).json({ error: "comment required" });
    const controller = require("../controller.js");
    const SteamUser = require("steam-user");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    if (!bot.webCookies) { bot.client.webLogOn(); return res.status(202).json({ error: "Requesting web session, try again" }); }
    const username = req.params.username;
    if (commentProgress[username] && commentProgress[username].running) return res.status(400).json({ error: "Already running" });

    const friends = [];
    if (Array.isArray(steamIds) && steamIds.length > 0) {
        friends.push(...steamIds.map(String));
    } else {
        for (const [sid, rel] of Object.entries(bot.client.myFriends || {})) {
            if (rel === SteamUser.EFriendRelationship.Friend) friends.push(String(sid));
        }
    }

    const prog = { total: friends.length, done: 0, errors: 0, running: true, log: [] };
    commentProgress[username] = prog;
    res.json({ ok: true, total: friends.length });

    const delayMs = Math.max((delay || 15) * 1000, 5000);
    const skipPatterns = /private|comment.*disabled|owner only|limit|restricted|unavailable|cannot post|you do not have permission/i;
    const skipDelay = 2000;
    (async () => {
        for (const sid of friends) {
            if (!prog.running) { prog.log.push({ steamId: sid, name: (bot.client.users[sid] || {}).player_name || sid, status: "cancelled" }); break; }
            const name = (bot.client.users[sid] || {}).player_name || sid;
            let wasSkipped = false;
            try {
                const result = await steamWebPost(bot, "https://steamcommunity.com/comment/Profile/post/" + sid + "/-1/", { comment });
                const parsed = JSON.parse(result.data);
                if (parsed.success) {
                    prog.done++;
                    prog.log.push({ steamId: sid, name, status: "ok" });
                } else {
                    const errMsg = parsed.error || "Failed";
                    if (skipPatterns.test(errMsg)) {
                        prog.log.push({ steamId: sid, name, status: "skipped", error: errMsg });
                        wasSkipped = true;
                    } else {
                        prog.errors++;
                        prog.log.push({ steamId: sid, name, status: "error", error: errMsg });
                    }
                }
            } catch (e) {
                if (skipPatterns.test(e.message)) {
                    prog.log.push({ steamId: sid, name, status: "skipped", error: e.message });
                    wasSkipped = true;
                } else {
                    prog.errors++;
                    prog.log.push({ steamId: sid, name, status: "error", error: e.message });
                }
            }
            if (prog.running) await new Promise(r => setTimeout(r, wasSkipped ? skipDelay : delayMs));
        }
        prog.running = false;
    })();
});

// Stop bulk commenting
app.post("/api/accounts/:username/comment/stop", (req, res) => {
    const prog = commentProgress[req.params.username];
    if (prog) prog.running = false;
    res.json({ ok: true });
});

// Get bulk comment progress
app.get("/api/accounts/:username/comment/progress", (req, res) => {
    const prog = commentProgress[req.params.username] || { total: 0, done: 0, errors: 0, running: false, log: [] };
    res.json(prog);
});

// --- Mass account commenter ---
let massCommentProgress = { total: 0, done: 0, errors: 0, running: false, log: [] };

app.post("/api/masscomment/start", async (req, res) => {
    const { targetSteamId, comment, delay, usernames } = req.body;
    if (!targetSteamId || !comment) return res.status(400).json({ error: "targetSteamId and comment required" });
    if (!Array.isArray(usernames) || usernames.length === 0) return res.status(400).json({ error: "No accounts selected" });
    if (massCommentProgress.running) return res.status(400).json({ error: "Already running" });

    const controller = require("../controller.js");
    const selectedBots = usernames
        .map(u => controller.allBots.find(b => b.logOnOptions.accountName === u))
        .filter(b => b && b.client.steamID);

    if (selectedBots.length === 0) return res.status(400).json({ error: "No selected accounts are online" });

    const prog = { total: selectedBots.length, done: 0, errors: 0, running: true, log: [] };
    massCommentProgress = prog;
    res.json({ ok: true, total: selectedBots.length });

    const delayMs = Math.max((delay || 15) * 1000, 5000);
    const skipPatterns = /private|comment.*disabled|owner only|limit|restricted|unavailable|cannot post|you do not have permission/i;
    const skipDelay = 2000;
    (async () => {
        for (const bot of selectedBots) {
            if (!prog.running) { prog.log.push({ account: bot.logOnOptions.accountName, status: "cancelled" }); break; }
            const name = bot.logOnOptions.accountName;
            let wasSkipped = false;
            if (!bot.webCookies) {
                try { bot.client.webLogOn(); } catch (e) { /* ignore */ }
                prog.log.push({ account: name, status: "skipped", error: "No web session" });
                wasSkipped = true;
            } else {
                try {
                    const result = await steamWebPost(bot, "https://steamcommunity.com/comment/Profile/post/" + targetSteamId + "/-1/", { comment });
                    const parsed = JSON.parse(result.data);
                    if (parsed.success) {
                        prog.done++;
                        prog.log.push({ account: name, status: "ok" });
                    } else {
                        const errMsg = parsed.error || "Failed";
                        if (skipPatterns.test(errMsg)) {
                            prog.log.push({ account: name, status: "skipped", error: errMsg });
                            wasSkipped = true;
                        } else {
                            prog.errors++;
                            prog.log.push({ account: name, status: "error", error: errMsg });
                        }
                    }
                } catch (e) {
                    if (skipPatterns.test(e.message)) {
                        prog.log.push({ account: name, status: "skipped", error: e.message });
                        wasSkipped = true;
                    } else {
                        prog.errors++;
                        prog.log.push({ account: name, status: "error", error: e.message });
                    }
                }
            }
            if (prog.running) await new Promise(r => setTimeout(r, wasSkipped ? skipDelay : delayMs));
        }
        prog.running = false;
    })();
});

app.post("/api/masscomment/stop", (req, res) => {
    massCommentProgress.running = false;
    res.json({ ok: true });
});

app.get("/api/masscomment/progress", (req, res) => {
    res.json(massCommentProgress);
});

// Friends list
app.get("/api/accounts/:username/friends", (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.json({ friends: [] });
    const SteamUser = require("steam-user");
    const friends = [];
    for (const [sid, rel] of Object.entries(bot.client.myFriends || {})) {
        if (rel !== SteamUser.EFriendRelationship.Friend) continue;
        const sid64 = String(sid);
        const user = bot.client.users[sid64] || {};
        const state = user.persona_state !== undefined ? user.persona_state : 0;
        const stateNames = ["Offline","Online","Busy","Away","Snooze","Looking to Trade","Looking to Play"];
        friends.push({
            steamId: sid64,
            name: user.player_name || sid64,
            avatar: user.avatar_url_icon || "",
            state,
            stateName: stateNames[state] || "Offline",
            gameName: user.game_name || ""
        });
    }
    friends.sort((a, b) => {
        if (a.state === 0 && b.state !== 0) return 1;
        if (a.state !== 0 && b.state === 0) return -1;
        return a.name.localeCompare(b.name);
    });
    res.json({ friends });
});

// Chat relay - get messages for an account
app.get("/api/accounts/:username/chat", (req, res) => {
    const since = parseInt(req.query.since) || 0;
    const msgs = (chatBuffers[req.params.username] || []).filter(m => m.seq > since);
    res.json({ messages: msgs });
});

// Playtime history (cached, invalidated when file changes)
let _playtimeCache = null;
let _playtimeMtime = 0;
app.get("/api/playtime", (req, res) => {
    if (!fs.existsSync(playtimePath)) return res.json([]);
    const mtime = fs.statSync(playtimePath).mtimeMs;
    if (_playtimeCache && mtime === _playtimeMtime) return res.json(_playtimeCache);
    const lines = fs.readFileSync(playtimePath, "utf8").split("\n").filter(Boolean);
    const entries = lines.map(line => {
        const match = line.match(/^\[(.+?)\] Session Summary \((.+?) - (.+?)\) ~ Played for (\d+) seconds: (.+)$/);
        if (!match) return { raw: line };
        return { account: match[1], start: match[2], end: match[3], seconds: parseInt(match[4]), games: match[5] };
    });
    _playtimeCache = entries.reverse();
    _playtimeMtime = mtime;
    res.json(_playtimeCache);
});

// --- Group Commenter ---
const groupCommentProgress = {};

app.get("/api/accounts/:username/groups/resolved", async (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.json({ groups: [] });
    const https = require("https");
    const sid64 = bot.client.steamID.getSteamID64();
    const cookieStr = bot.webCookies ? bot.webCookies.join("; ") : "";

    function httpGet(hostname, path) {
        return new Promise((resolve, reject) => {
            const opts = { hostname, path, headers: { "User-Agent": "Mozilla/5.0" } };
            if (cookieStr) opts.headers["Cookie"] = cookieStr;
            https.get(opts, (r) => {
                let d = ""; r.on("data", c => d += c); r.on("end", () => resolve(d));
            }).on("error", reject);
        });
    }

    try {
        const html = await httpGet("steamcommunity.com", `/profiles/${sid64}`);
        const groups = [];
        const blocks = html.split(/class="profile_group(?:\s+profile_primary_group)?"/g);
        for (let i = 1; i < blocks.length; i++) {
            const b = blocks[i];
            const nameMatch = b.match(/whiteLink"[^>]*>([\s\S]*?)<\/a>/);
            const urlMatch = b.match(/href="(https:\/\/steamcommunity\.com\/groups\/([^"]*?))"/);
            const avMatch = b.match(/<img src="(https:\/\/avatars[^"]*?)"/);
            const memberMatch = b.match(/profile_group_membercount">\s*([\d,]+)\s*Members/);
            if (nameMatch && urlMatch) {
                groups.push({
                    name: nameMatch[1].trim(),
                    url: urlMatch[1],
                    slug: urlMatch[2],
                    avatar: avMatch ? avMatch[1] : "",
                    members: memberMatch ? parseInt(memberMatch[1].replace(/,/g, "")) : 0,
                    groupId: ""
                });
            }
        }
        for (const g of groups) {
            try {
                const gPage = await httpGet("steamcommunity.com", `/groups/${g.slug}`);
                const commentMatch = gPage.match(/comment\/Clan\/post\/(\d+)/);
                const chatMatch = gPage.match(/joinchat\/(\d+)/) || gPage.match(/"steamid":"(\d+)"/) || gPage.match(/OpenGroupChat\(\s*'(\d+)'/);
                g.groupId = commentMatch ? commentMatch[1] : (chatMatch ? chatMatch[1] : "");
            } catch (e) {}
        }
        res.json({ groups });
    } catch (e) {
        res.json({ groups: [], error: e.message });
    }
});

app.post("/api/accounts/:username/group/comment", async (req, res) => {
    const { groupIds, comment, delay } = req.body;
    if (!comment) return res.status(400).json({ error: "comment required" });
    if (!Array.isArray(groupIds) || groupIds.length === 0) return res.status(400).json({ error: "No groups selected" });
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    if (!bot.webCookies) { bot.client.webLogOn(); return res.status(202).json({ error: "Requesting web session, try again" }); }
    const username = req.params.username;
    if (groupCommentProgress[username] && groupCommentProgress[username].running) return res.status(400).json({ error: "Already running" });

    const prog = { total: groupIds.length, done: 0, errors: 0, running: true, log: [] };
    groupCommentProgress[username] = prog;
    res.json({ ok: true, total: groupIds.length });

    const delayMs = Math.max((delay || 15) * 1000, 5000);
    const skipPatterns = /private|comment.*disabled|owner only|limit|restricted|unavailable|cannot post|you do not have permission|not a member/i;
    (async () => {
        try {
            for (const g of groupIds) {
                if (!prog.running) { prog.log.push({ groupId: g.id, name: g.name, status: "cancelled" }); break; }
                try {
                    const result = await steamWebPost(bot, "https://steamcommunity.com/comment/Clan/post/" + g.id + "/-1/", { comment });
                    let parsed;
                    try { parsed = JSON.parse(result.data); } catch (_) { parsed = { success: false, error: "Bad response from Steam" }; }
                    if (parsed.success) {
                        prog.done++;
                        prog.log.push({ groupId: g.id, name: g.name, status: "ok" });
                    } else {
                        const errMsg = parsed.error || "Failed";
                        if (skipPatterns.test(errMsg)) {
                            prog.log.push({ groupId: g.id, name: g.name, status: "skipped", error: errMsg });
                        } else {
                            prog.errors++;
                            prog.log.push({ groupId: g.id, name: g.name, status: "error", error: errMsg });
                        }
                    }
                } catch (e) {
                    const errMsg = e.message || String(e);
                    if (skipPatterns.test(errMsg)) {
                        prog.log.push({ groupId: g.id, name: g.name, status: "skipped", error: errMsg });
                    } else {
                        prog.errors++;
                        prog.log.push({ groupId: g.id, name: g.name, status: "error", error: errMsg });
                    }
                }
                if (prog.running) await new Promise(r => setTimeout(r, delayMs));
            }
        } catch (outerErr) {
            prog.log.push({ groupId: "?", name: "System", status: "error", error: outerErr.message || String(outerErr) });
        }
        prog.running = false;
    })();
});

app.post("/api/accounts/:username/group/comment/stop", (req, res) => {
    const prog = groupCommentProgress[req.params.username];
    if (prog) prog.running = false;
    res.json({ ok: true });
});

app.post("/api/accounts/:username/group/comment/reset", (req, res) => {
    delete groupCommentProgress[req.params.username];
    res.json({ ok: true });
});

app.get("/api/accounts/:username/group/comment/progress", (req, res) => {
    const prog = groupCommentProgress[req.params.username] || { total: 0, done: 0, errors: 0, running: false, log: [] };
    res.json(prog);
});

// --- Art Maker proxy (streaming) ---
app.get("/api/artwork/proxy", (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "url required" });
    const https = require("https");
    const http = require("http");
    const followRedirects = (u, redirects) => {
        if (redirects > 5) { res.status(500).json({ error: "Too many redirects" }); return; }
        const mod = u.startsWith("https") ? https : http;
        mod.get(u, { headers: { "User-Agent": "Mozilla/5.0" } }, (resp) => {
            if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
                return followRedirects(resp.headers.location, redirects + 1);
            }
            const ct = resp.headers["content-type"] || "application/octet-stream";
            res.set("Content-Type", ct);
            res.set("Cache-Control", "public, max-age=86400");
            if (resp.headers["content-length"]) res.set("Content-Length", resp.headers["content-length"]);
            if (resp.headers["accept-ranges"]) res.set("Accept-Ranges", resp.headers["accept-ranges"]);
            resp.pipe(res);
        }).on("error", (e) => {
            if (!res.headersSent) res.status(500).json({ error: e.message });
        });
    };
    followRedirects(url, 0);
});

// --- Fetch profile backgrounds from inventory ---
app.get("/api/accounts/:username/backgrounds", async (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.json({ backgrounds: [], error: "Bot not online" });
    const sid64 = bot.client.steamID.getSteamID64();
    const https = require("https");
    if (!bot.webCookies) {
        try { bot.client.webLogOn(); } catch (e) {}
        return res.json({ backgrounds: [], error: "Web session not ready. Please wait a moment and try again." });
    }
    const cookieStr = bot.webCookies.join("; ");

    function httpsGet(hostname, path, cookies) {
        return new Promise((resolve, reject) => {
            const headers = { "User-Agent": "Mozilla/5.0" };
            if (cookies) headers.Cookie = cookies;
            https.get({ hostname, path, headers }, (r) => {
                let d = ""; r.on("data", c => d += c);
                r.on("end", () => resolve(d));
            }).on("error", () => resolve(""));
        });
    }

    try {
        const backgrounds = [];
        const CDN = "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/";
        const addedCiids = new Set();

        // 1. Build primary list from IPlayerService (guaranteed full-res CDN URLs)
        const loginCookie = bot.webCookies.find(c => c.startsWith("steamLoginSecure="));
        let accessToken = "";
        if (loginCookie) {
            const tokenParts = loginCookie.split("=")[1].split("%7C%7C");
            if (tokenParts.length > 1) accessToken = decodeURIComponent(tokenParts[1]);
        }

        const piBgs = [];
        if (accessToken) {
            try {
                const profileItemsJson = await httpsGet("api.steampowered.com",
                    `/IPlayerService/GetProfileItemsOwned/v1?access_token=${encodeURIComponent(accessToken)}`);
                const profileItems = JSON.parse(profileItemsJson);
                piBgs.push(...(profileItems.response?.profile_backgrounds || []));
            } catch (e) {}
        }

        for (const bg of piBgs) {
            if (!bg.image_large) continue;
            const isAnimated = !!bg.movie_webm;
            backgrounds.push({
                name: bg.item_title || bg.name || "Background",
                appName: "",
                icon: bg.image_small ? CDN + bg.image_small : CDN + bg.image_large,
                full: CDN + bg.image_large,
                movie: bg.movie_webm ? CDN + bg.movie_webm : "",
                classid: "",
                appid: String(bg.appid || ""),
                communityitemid: String(bg.communityitemid || ""),
                type: isAnimated ? "Animated Profile Background" : "Profile Background",
                animated: isAnimated
            });
            if (bg.communityitemid) addedCiids.add(String(bg.communityitemid));
        }

        // 2. Fetch inventory for game names and any backgrounds missing from IPlayerService
        const bgPage = await new Promise((resolve, reject) => {
            https.get({
                hostname: "steamcommunity.com",
                path: `/profiles/${sid64}/inventory/json/753/6?l=english&count=5000`,
                headers: { "User-Agent": "Mozilla/5.0", "Cookie": cookieStr }
            }, (r) => { let d = ""; r.on("data", c => d += c); r.on("end", () => resolve(d)); }).on("error", reject);
        });

        try {
            const inv = JSON.parse(bgPage);
            const assetIdMap = {};
            if (inv.rgInventory) {
                for (const asset of Object.values(inv.rgInventory)) {
                    if (asset.classid) assetIdMap[asset.classid] = asset.id;
                }
            }
            if (inv.success && inv.rgDescriptions) {
                // Build appid->gameName map from inventory tags
                const appNameMap = {};
                for (const key of Object.keys(inv.rgDescriptions)) {
                    const item = inv.rgDescriptions[key];
                    if (item.tags && item.market_fee_app) {
                        const gameTag = item.tags.find(t => t.category === "Game");
                        if (gameTag) appNameMap[String(item.market_fee_app)] = gameTag.localized_tag_name || "";
                    }
                }

                // Enrich IPlayerService backgrounds with game names
                for (const bg of backgrounds) {
                    if (!bg.appName && bg.appid && appNameMap[bg.appid]) {
                        bg.appName = appNameMap[bg.appid];
                    }
                }

                // Add any inventory backgrounds not already covered by IPlayerService
                for (const key of Object.keys(inv.rgDescriptions)) {
                    const item = inv.rgDescriptions[key];
                    const typeLower = (item.type || "").toLowerCase();
                    if (!typeLower.includes("background")) continue;
                    if (typeLower.includes("mini profile")) continue;

                    const ciid = item.classid && assetIdMap[item.classid] ? assetIdMap[item.classid] : "";
                    if (ciid && addedCiids.has(ciid)) continue;

                    // Check if already added by matching appid + name
                    const invName = (item.market_name || item.name || "").toLowerCase();
                    const alreadyAdded = backgrounds.some(b =>
                        b.appid === String(item.market_fee_app || "") &&
                        b.name.toLowerCase() === invName.replace(/\s*\(profile background\)\s*/i, "").trim()
                    );
                    if (alreadyAdded) continue;

                    let imgUrl = "";
                    if (item.icon_url) imgUrl = "https://community.fastly.steamstatic.com/economy/image/" + item.icon_url;
                    if (!imgUrl && item.icon_url_large) imgUrl = "https://community.fastly.steamstatic.com/economy/image/" + item.icon_url_large;
                    const fullImg = item.icon_url_large
                        ? "https://community.fastly.steamstatic.com/economy/image/" + item.icon_url_large
                        : imgUrl;

                    let movieUrl = "";
                    for (const descs of [item.descriptions, item.owner_descriptions]) {
                        if (!descs || movieUrl) continue;
                        for (const d of descs) {
                            const val = d.value || "";
                            const webmMatch = val.match(/(https?:\/\/[^\s"'<>]+\.webm)/i);
                            const mp4Match = val.match(/(https?:\/\/[^\s"'<>]+\.mp4)/i);
                            if (webmMatch) { movieUrl = webmMatch[1]; break; }
                            else if (mp4Match) { movieUrl = mp4Match[1]; break; }
                        }
                    }

                    let isAnimated = typeLower.includes("animated") || !!movieUrl;
                    if (!isAnimated && item.tags) {
                        isAnimated = item.tags.some(t => {
                            const tn = (t.localized_tag_name || t.internal_name || "").toLowerCase();
                            return tn.includes("animated");
                        });
                    }

                    backgrounds.push({
                        name: item.market_name || item.name || "Background",
                        appName: item.tags ? (item.tags.find(t => t.category === "Game") || {}).localized_tag_name || "" : "",
                        icon: imgUrl,
                        full: fullImg,
                        movie: movieUrl || "",
                        classid: item.classid || "",
                        appid: item.market_fee_app || "",
                        communityitemid: ciid,
                        type: item.type || "",
                        animated: isAnimated
                    });
                }
            }
        } catch (e) {}

        res.json({ backgrounds });
    } catch (e) {
        res.json({ backgrounds: [], error: e.message });
    }
});

// --- Apply profile background to Steam via IPlayerService API ---
app.post("/api/accounts/:username/profile/background", async (req, res) => {
    const controller = require("../controller.js");
    const https = require("https");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    if (!bot.webCookies) { bot.client.webLogOn(); return res.status(202).json({ error: "Requesting web session, try again" }); }
    const { communityitemid } = req.body;
    if (!communityitemid) return res.status(400).json({ error: "No communityitemid provided" });
    try {
        const loginCookie = bot.webCookies.find(c => c.startsWith("steamLoginSecure="));
        if (!loginCookie) return res.status(400).json({ error: "No steamLoginSecure cookie" });
        const tokenParts = loginCookie.split("=")[1].split("%7C%7C");
        if (tokenParts.length < 2) return res.status(400).json({ error: "Could not extract access token" });
        const accessToken = decodeURIComponent(tokenParts[1]);

        const body = `access_token=${encodeURIComponent(accessToken)}&communityitemid=${communityitemid}`;

        const result = await new Promise((resolve, reject) => {
            const postReq = https.request({
                hostname: "api.steampowered.com",
                path: "/IPlayerService/SetProfileBackground/v1/",
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Length": Buffer.byteLength(body)
                }
            }, (resp) => {
                let d = ""; resp.on("data", c => d += c);
                resp.on("end", () => resolve({ status: resp.statusCode, data: d }));
            });
            postReq.on("error", reject);
            postReq.write(body);
            postReq.end();
        });

        console.log("[BG] SetProfileBackground response:", result.status, result.data.substring(0, 300));

        if (result.status === 200) {
            try {
                const parsed = JSON.parse(result.data);
                if (parsed.response !== undefined) return res.json({ ok: true });
                return res.json({ ok: false, error: "Unexpected response" });
            } catch(e) {
                if (result.data.trim() === "" || result.data.includes("{}")) return res.json({ ok: true });
                return res.json({ ok: false, error: "Parse error: " + result.data.substring(0, 100) });
            }
        } else {
            return res.json({ ok: false, error: "Steam API returned HTTP " + result.status + ": " + result.data.substring(0, 200) });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Apply artwork showcase to Steam profile ---
app.post("/api/accounts/:username/profile/showcase", async (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    if (!bot.webCookies) { bot.client.webLogOn(); return res.status(202).json({ error: "Requesting web session, try again" }); }
    const https = require("https");
    const sid64 = bot.client.steamID.getSteamID64();
    const cookieStr = bot.webCookies.join("; ");
    const sessionId = bot.webCookies.find(c => c.startsWith("sessionid="))?.split("=")[1];

    try {
        // First fetch current profile showcases to find/update the artwork showcase slot
        const editPage = await new Promise((resolve, reject) => {
            https.get({
                hostname: "steamcommunity.com",
                path: `/profiles/${sid64}/edit/showcases`,
                headers: { "User-Agent": "Mozilla/5.0", "Cookie": cookieStr }
            }, (r) => {
                let d = ""; r.on("data", c => d += c);
                r.on("end", () => resolve(d));
            }).on("error", reject);
        });

        // Find the current showcase config
        const configMatch = editPage.match(/g_rgShowcaseConfig\s*=\s*(\[[\s\S]*?\]);/);
        let showcaseSlot = 0;
        if (configMatch) {
            try {
                const config = JSON.parse(configMatch[1]);
                const artIdx = config.findIndex(s => s.nAppId === 6 || s.nShowcaseType === 6);
                if (artIdx >= 0) showcaseSlot = artIdx;
            } catch (e) {}
        }

        // Enable the artwork showcase (type 6 = featured artwork)
        const webSessionId = bot.webSessionId || sessionId;
        const formEntries = {
            sessionid: webSessionId,
            json: "1",
            customization_type: "6",
            slot: String(showcaseSlot),
        };
        const body = Object.entries(formEntries).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");

        const result = await new Promise((resolve, reject) => {
            const postReq = https.request({
                hostname: "steamcommunity.com",
                path: `/profiles/${sid64}/ajaxsetshowcase/`,
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Length": Buffer.byteLength(body),
                    "Cookie": cookieStr,
                    "Origin": "https://steamcommunity.com",
                    "Referer": `https://steamcommunity.com/profiles/${sid64}/edit/showcases`,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                }
            }, (resp) => {
                let d = ""; resp.on("data", c => d += c);
                resp.on("end", () => resolve({ status: resp.statusCode, headers: resp.headers, data: d }));
            });
            postReq.on("error", reject);
            postReq.write(body);
            postReq.end();
        });

        console.log("[SHOWCASE] Response:", result.status, result.data.substring(0, 300));
        if (result.status === 200) {
            try {
                const parsed = JSON.parse(result.data);
                if (parsed.success === 1 || parsed.success === true) return res.json({ ok: true });
                return res.json({ ok: true, note: "Showcase may need manual setup" });
            } catch(e) {
                return res.json({ ok: true });
            }
        }
        // 302 = session redirect; return partial success so upload flow continues
        res.json({ ok: true, note: "Showcase auto-enable not supported. Enable 'Artwork Showcase' from your Steam profile edit page." });
    } catch (e) {
        res.json({ ok: true, note: "Showcase: " + e.message + ". Enable manually from Steam profile." });
    }
});

// --- Art Maker upload ---
app.post("/api/accounts/:username/artwork/upload", express.raw({ type: "image/*", limit: "20mb" }), async (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    if (!bot.webCookies) { bot.client.webLogOn(); return res.status(202).json({ error: "Requesting web session, try again" }); }
    try {
        const steamId = bot.client.steamID.getSteamID64();
        const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substr(2);
        const title = req.query.title || "Artwork";
        const imgBuf = req.body;
        const ext = (req.headers["content-type"] || "").includes("png") ? "png" : "jpg";

        const isAnimated = req.query.animated === "true";
        const sessionId = bot.webSessionId || bot.webCookies.find(c => c.startsWith("sessionid="))?.split("=")[1] || "";
        let body = "";
        body += `--${boundary}\r\nContent-Disposition: form-data; name="sessionid"\r\n\r\n${sessionId}\r\n`;
        body += `--${boundary}\r\nContent-Disposition: form-data; name="l"\r\n\r\nenglish\r\n`;
        body += `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n`;
        body += `--${boundary}\r\nContent-Disposition: form-data; name="file_type"\r\n\r\n0\r\n`;
        body += `--${boundary}\r\nContent-Disposition: form-data; name="visibility"\r\n\r\n0\r\n`;
        if (isAnimated) {
            body += `--${boundary}\r\nContent-Disposition: form-data; name="image_width"\r\n\r\n1000\r\n`;
            body += `--${boundary}\r\nContent-Disposition: form-data; name="image_height"\r\n\r\n1\r\n`;
        }
        const bodyStart = Buffer.from(body);
        const fileHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="artwork.${ext}"\r\nContent-Type: image/${ext}\r\n\r\n`);
        const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
        const fullBody = Buffer.concat([bodyStart, fileHeader, imgBuf, bodyEnd]);

        const https = require("https");
        const result = await new Promise((resolve, reject) => {
            const opts = {
                hostname: "steamcommunity.com",
                path: `/sharedfiles/edititem/767/3/`,
                method: "POST",
                headers: {
                    "Content-Type": `multipart/form-data; boundary=${boundary}`,
                    "Content-Length": fullBody.length,
                    "Cookie": bot.webCookies.join("; "),
                    "Referer": `https://steamcommunity.com/profiles/${steamId}/images/`,
                    "User-Agent": "Mozilla/5.0"
                }
            };
            const r = https.request(opts, (resp) => {
                const chunks = [];
                resp.on("data", c => chunks.push(c));
                resp.on("end", () => resolve({ status: resp.statusCode, data: Buffer.concat(chunks).toString() }));
                resp.on("error", reject);
            });
            r.on("error", reject);
            r.write(fullBody);
            r.end();
        });
        console.log("[ARTWORK] Upload response:", result.status, result.data.substring(0, 200));
        if (result.status === 200 || result.status === 302) {
            res.json({ ok: true });
        } else {
            res.status(400).json({ error: "Upload failed (HTTP " + result.status + "): " + result.data.substring(0, 200) });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- GIF search via Tenor v1 ---
app.get("/api/gif/search", async (req, res) => {
    const https = require("https");
    const q = req.query.q || "";
    if (!q) return res.json({ results: [] });
    const key = "LIVDSRZULELA";
    const url = `/v1/search?q=${encodeURIComponent(q)}&key=${key}&limit=30&media_filter=minimal`;
    try {
        const data = await new Promise((resolve, reject) => {
            https.get({ hostname: "g.tenor.com", path: url }, (resp) => {
                let d = ""; resp.on("data", c => d += c);
                resp.on("end", () => resolve(d));
            }).on("error", reject);
        });
        const parsed = JSON.parse(data);
        const results = (parsed.results || []).map(r => {
            const media = r.media?.[0] || {};
            return {
                id: r.id,
                title: r.content_description || r.title || "",
                preview: media.tinygif?.url || media.nanogif?.url || "",
                full: media.gif?.url || media.mediumgif?.url || "",
                dims: media.gif?.dims || [0, 0]
            };
        });
        res.json({ results });
    } catch (e) {
        res.json({ results: [], error: e.message });
    }
});

// --- Start server ---

let bundledWebDir = null;

module.exports.startServer = function(webDir) {
    if (webDir) bundledWebDir = webDir;
    return new Promise((resolve) => {
        app.listen(PORT, () => {
            const bg = resolveAppBackground();
            if (bg) {
                refreshEmbeddedBgDataUri();
                console.log(`  Dashboard background: ${bg.filePath} (${bg.mime})`);
            } else {
                console.warn("  Warning: No dashboard background image found (bg.webp / bg.png).");
            }
            console.log(`\n  Steam Idler dashboard running at http://localhost:${PORT}\n`);
            resolve(PORT);
        });
    });
};
