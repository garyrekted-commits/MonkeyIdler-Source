/*
 * File: server.js
 * Project: steam-idler
 *
 * Express-based web server providing the dashboard UI and REST API.
 */

const fs      = require("fs");
const path    = require("path");
const express = require("express");

const configPath   = "./config.json";
const accountsPath = "./accounts.txt";
const playtimePath = "./playtime.txt";

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
        fs.writeFileSync(configPath, JSON.stringify(defaults, null, 4) + "\n");
        _configCache = defaults;
        return defaults;
    }
    _configCache = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return _configCache;
}

function saveConfig(config) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + "\n");
    _configCache = config;
}

function loadAccounts() {
    if (_accountsCache) return _accountsCache;
    if (!fs.existsSync(accountsPath)) return [];
    const lines = fs.readFileSync(accountsPath, "utf8").split("\n");
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
    fs.writeFileSync(accountsPath, header + "\n" + lines.join("\n") + "\n");
    _accountsCache = accounts;
}

// --- Routes ---

// Serve dashboard
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

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
                    const db = new nedb({ filename: "./src/tokens.db", autoload: true });
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

// Toggle a game for idling on a specific account
app.post("/api/accounts/:username/toggle", (req, res) => {
    const { appid } = req.body;
    if (!appid) return res.status(400).json({ error: "appid required" });
    const config = loadConfig();
    if (!config.accountSettings) config.accountSettings = {};
    const username = req.params.username;
    if (!config.accountSettings[username]) config.accountSettings[username] = {};
    let games = config.accountSettings[username].playingGames || [...(config.playingGames || [])];
    // Only keep numeric appids for toggling; preserve custom game strings
    const idx = games.indexOf(appid);
    if (idx !== -1) {
        games.splice(idx, 1);
    } else {
        games.push(appid);
    }
    config.accountSettings[username].playingGames = games;
    saveConfig(config);
    // Apply live if bot is running
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === username);
    if (bot && bot.client.steamID) {
        bot.setGamesPlayed(games);
    }
    res.json({ ok: true, idling: games });
});

// Stop idling but stay online
app.post("/api/accounts/:username/stopidle", (req, res) => {
    const controller = require("../controller.js");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    bot.client.gamesPlayed([]);
    bot.playedAppIDs = [];
    const config = loadConfig();
    if (!config.accountSettings) config.accountSettings = {};
    if (!config.accountSettings[req.params.username]) config.accountSettings[req.params.username] = {};
    config.accountSettings[req.params.username].playingGames = [];
    saveConfig(config);
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
        level: bot.steamLevel || 0
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

// Bulk comment on all friends
app.post("/api/accounts/:username/comment/bulk", async (req, res) => {
    const { comment, delay } = req.body;
    if (!comment) return res.status(400).json({ error: "comment required" });
    const controller = require("../controller.js");
    const SteamUser = require("steam-user");
    const bot = controller.allBots.find(b => b.logOnOptions.accountName === req.params.username);
    if (!bot || !bot.client.steamID) return res.status(400).json({ error: "Bot not online" });
    if (!bot.webCookies) { bot.client.webLogOn(); return res.status(202).json({ error: "Requesting web session, try again" }); }
    const username = req.params.username;
    if (commentProgress[username] && commentProgress[username].running) return res.status(400).json({ error: "Already running" });

    const friends = [];
    for (const [sid, rel] of Object.entries(bot.client.myFriends || {})) {
        if (rel === SteamUser.EFriendRelationship.Friend) friends.push(String(sid));
    }

    const prog = { total: friends.length, done: 0, errors: 0, running: true, log: [] };
    commentProgress[username] = prog;
    res.json({ ok: true, total: friends.length });

    const delayMs = Math.max((delay || 15) * 1000, 5000);
    (async () => {
        for (const sid of friends) {
            if (!prog.running) { prog.log.push({ steamId: sid, status: "cancelled" }); break; }
            try {
                const result = await steamWebPost(bot, "https://steamcommunity.com/comment/Profile/post/" + sid + "/-1/", { comment });
                const parsed = JSON.parse(result.data);
                if (parsed.success) {
                    prog.done++;
                    const name = (bot.client.users[sid] || {}).player_name || sid;
                    prog.log.push({ steamId: sid, name, status: "ok" });
                } else {
                    prog.errors++;
                    prog.log.push({ steamId: sid, status: "error", error: parsed.error || "Failed" });
                }
            } catch (e) {
                prog.errors++;
                prog.log.push({ steamId: sid, status: "error", error: e.message });
            }
            if (prog.running) await new Promise(r => setTimeout(r, delayMs));
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

// --- Start server ---

module.exports.startServer = function() {
    return new Promise((resolve) => {
        app.listen(PORT, () => {
            console.log(`\n  Steam Idler dashboard running at http://localhost:${PORT}\n`);
            resolve(PORT);
        });
    });
};
