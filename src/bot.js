/*
 * File: bot.js
 * Project: steam-idler
 * Created Date: 2022-10-17 17:32:28
 * Author: 3urobeat
 *
 * Last Modified: 2026-01-14 21:30:19
 * Modified By: 3urobeat
 *
 * Copyright (c) 2022 - 2026 3urobeat <https://github.com/3urobeat>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 * You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
 */


const fs        = require("fs");
const path      = require("path");
const util      = require("util");
const SteamID   = require("steamid");
const SteamTotp = require("steam-totp");
const SteamUser = require("steam-user");
const EResult   = SteamUser.EResult;

const dataDir = global.dataDir || ".";
const { readSecure, writeSecure } = require("./dataCrypt.js");
const sessionHandler = require("./sessions/sessionHandler.js");
const controller     = require("./controller.js");


/**
 * Constructor Creates a new bot object and logs in the account
 * @param {object} logOnOptions The logOnOptions obj for this account
 * @param {number} loginindex The loginindex for this account
 * @param {Array} proxies
 * @param {object} acctConfig Per-account config (merged global defaults + account overrides)
 */
const Bot = function(logOnOptions, loginindex, proxies, acctConfig) {

    this.logOnOptions = logOnOptions;
    this.loginindex   = loginindex;
    this.acctConfig   = acctConfig;
    this.proxy        = proxies[loginindex % proxies.length]; // Spread all accounts equally with a simple modulo calculation

    // Populated by loggedOn event handler, is used by logPlaytime to calculate playtime report for this account
    this.startedPlayingTimestamp = 0;
    this.playedAppIDs = [];
    this.steamLevel = 0;

    // Cached list of owned games, populated after login
    this.ownedGames = [];
    this.goalCheckInterval = null;

    // Create new steam-user bot object. Disable autoRelogin as we have our own queue system
    this.client = new SteamUser({ autoRelogin: false, renewRefreshTokens: true, httpProxy: this.proxy, protocol: SteamUser.EConnectionProtocol.WebSocket }); // Forcing protocol for now: https://dev.doctormckay.com/topic/4187-disconnect-due-to-encryption-error-causes-relog-to-break-error-already-logged-on/?do=findComment&comment=10917

    this.session;

    // Attach relevant steam-user events
    this.attachEventListeners();

};

module.exports = Bot;


// Handles logging in this account
Bot.prototype.login = async function() {

    /* ------------ Login ------------ */
    if (this.proxy) logger("info", `Logging in ${this.logOnOptions.accountName} in ${this.acctConfig.loginDelay / 1000} seconds with proxy '${this.proxy}'...`);
        else logger("info", `Logging in ${this.logOnOptions.accountName} in ${this.acctConfig.loginDelay / 1000} seconds...`);

    // Generate steamGuardCode with shared secret if one was provided
    if (this.logOnOptions.sharedSecret) {
        this.logOnOptions.steamGuardCode = SteamTotp.generateAuthCode(this.logOnOptions.sharedSecret);
    }

    // Get new session for this account and log in
    this.session = new sessionHandler(this);

    const refreshToken = await this.session.getToken();
    if (!refreshToken) return; // Stop execution if getToken aborted login attempt

    setTimeout(() => this.client.logOn({ "refreshToken": refreshToken }), this.acctConfig.loginDelay);

};


// Attaches Steam event listeners
Bot.prototype.attachEventListeners = function() {

    this.webCookies = null;
    this.client.on("webSession", (sessionID, cookies) => {
        this.webCookies = cookies;
    });

    this.client.on("loggedOn", () => { // This account is now logged on
        controller.nextacc++;
        controller.loginEvents.emit("nextacc", controller.nextacc);

        // If this is a relog then remove this account from the queue and let the next account be able to relog
        if (controller.relogQueue.includes(this.loginindex)) {
            logger("info", `[${this.logOnOptions.accountName}] Relog successful.`);

            controller.relogQueue.splice(controller.relogQueue.indexOf(this.loginindex), 1); // Remove this loginindex from the queue
        } else {
            logger("info", `[${this.logOnOptions.accountName}] Logged in! Checking for missing licenses...`);
        }

        // Set online status if enabled (https://github.com/DoctorMcKay/node-steam-user/blob/master/enums/EPersonaState.js)
        if (this.acctConfig.onlinestatus) this.client.setPersona(this.acctConfig.onlinestatus);

        // Fetch Steam level for the dashboard
        this.client.getSteamLevels([this.client.steamID]).then(res => {
            const sid64 = this.client.steamID.getSteamID64();
            this.steamLevel = (res && res.users && res.users[sid64]) || 0;
            logger("info", `[${this.logOnOptions.accountName}] Steam Level: ${this.steamLevel}`);
        }).catch(err => {
            logger("warn", `[${this.logOnOptions.accountName}] Failed to fetch Steam level: ${err}`);
        });

        // Fetch full owned games library for the dashboard
        this.client.getUserOwnedApps(this.client.steamID, { includePlayedFreeGames: true, includeFreeSub: false }, (err, res) => {
            if (!err && res && res.apps) {
                this.ownedGames = res.apps.map(a => ({
                    appid: a.appid,
                    name: a.name,
                    playtimeForever: a.playtime_forever || 0,
                    img: `https://cdn.akamai.steamstatic.com/steam/apps/${a.appid}/header.jpg`
                })).sort((a, b) => a.name.localeCompare(b.name));
                logger("info", `[${this.logOnOptions.accountName}] Loaded ${this.ownedGames.length} owned games for dashboard.`);
            }
        });

        // Restore last-idled games from config so "Start All" resumes where we left off
        let configGames = this.acctConfig.playingGames || [];
        const shouldAutoResume = this.acctConfig.wasIdling === true;

        const startPlaying = () => {
            this.playedAppIDs = [];
            this.startedPlayingTimestamp = 0;
            this.lastConfigGames = configGames;

            if (shouldAutoResume && configGames.length > 0) {
                logger("info", `[${this.logOnOptions.accountName}] Resuming idle for ${configGames.length} game(s) (was idling before restart)...`);
                this.setGamesPlayed(configGames);
                this.startGoalCheck();
            }
        };

        // Get all licenses this account owns
        const options = {
            includePlayedFreeGames: true,
            filterAppids: configGames.filter(e => !isNaN(e)), // We only need to check for these appIDs. Filter custom game string
            includeFreeSub: false
        };

        this.client.getUserOwnedApps(this.client.steamID, options, (err, res) => {
            if (err) {
                logger("error", `[${this.logOnOptions.accountName}] Failed to get owned apps! Attempting to play set appIDs anyways...`);

                startPlaying(); // Start playing games
                return;
            }

            // Check if we are missing a license
            let missingLicenses = configGames.filter(e => !isNaN(e) && res.apps.filter(f => f.appid == e).length == 0);

            // Redeem missing licenses or start playing if none are missing. Event will get triggered again on change.
            if (missingLicenses.length > 0) {
                // Check if we are missing more than 50 licenses (limit per hour) and cut array
                if (missingLicenses.length > 50) {
                    logger("warn", `[${this.logOnOptions.accountName}] This account is missing more than 50 licenses! Steam only allows registering 50 licenses per hour.\n                             I will register 50 licenses now and relog this account in 1 hour to register the next 50 licenses.`);
                    missingLicenses = missingLicenses.splice(0, 50);

                    setTimeout(() => {
                        logger("info", `[${this.logOnOptions.accountName}] Relogging account to register the next 50 licenses...`);
                        this.handleRelog();
                    }, 3.6e+6 + 300000); // 1 hour plus 5 minutes for good measure
                }

                logger("info", `[${this.logOnOptions.accountName}] Requesting ${missingLicenses.length} missing license(s) before starting to play games set in config...`);

                this.client.requestFreeLicense(missingLicenses, (err) => {
                    if (err) {
                        logger("error", `[${this.logOnOptions.accountName}] Failed to request missing licenses! Starting to play anyways...`);
                        startPlaying(); // Start playing games
                    } else {
                        logger("info", `[${this.logOnOptions.accountName}] Successfully requested ${missingLicenses.length} missing game license(s)!`);
                        setTimeout(() => startPlaying(), 2500);
                    }
                });
            } else {
                logger("info", `[${this.logOnOptions.accountName}] Starting to idle ${configGames.length} games...`);
                startPlaying(); // Start playing games
            }
        });
    });


    this.client.chat.on("friendMessage", (msg) => {
        const message = msg.message_no_bbcode;
        const steamID = msg.steamid_friend;
        const steamID64 = new SteamID(String(steamID)).getSteamID64();
        const username  = this.client.users[steamID64] ? this.client.users[steamID64].player_name : "";

        logger("info", `[${this.logOnOptions.accountName}] Friend message from '${username}' (${steamID64}): ${message}`);

        // Forward to chat relay
        try {
            const server = require("./web/server.js");
            server.broadcastChat(this.logOnOptions.accountName, {
                from: username || steamID64,
                fromId: steamID64,
                message,
                timestamp: Date.now(),
                outgoing: false
            });
        } catch (e) { /* server not loaded */ }

        // Respond with afk message if enabled in config
        if (this.acctConfig.afkMessage && this.acctConfig.afkMessage.length > 0) {
            logger("info", "Responding with: " + this.acctConfig.afkMessage);
            this.client.chat.sendFriendMessage(steamID, this.acctConfig.afkMessage);

            // Also relay the auto-reply
            try {
                const server = require("./web/server.js");
                server.broadcastChat(this.logOnOptions.accountName, {
                    from: "You",
                    fromId: null,
                    message: this.acctConfig.afkMessage,
                    timestamp: Date.now(),
                    outgoing: true,
                    toId: steamID64
                });
            } catch (e) { /* server not loaded */ }
        }
    });


    this.client.on("disconnected", (eresult, msg) => { // Handle relogging
        if (controller.relogQueue.includes(this.loginindex)) return; // Don't handle this event if account is already waiting for relog
        this.stopGoalCheck();
        logger("info", `[${this.logOnOptions.accountName}] Lost connection to Steam. Message: ${msg}. Trying to relog in ${this.acctConfig.relogDelay / 1000} seconds...`);
        this.handleRelog();
    });


    this.client.on("error", (err) => {
        // Custom behavior for LogonSessionReplaced error
        if (err.eresult == SteamUser.EResult.LogonSessionReplaced) {
            logger("warn", `${logger.colors.fgred}[${this.logOnOptions.accountName}] Lost connection to Steam! Reason: LogonSessionReplaced. I won't try to relog this account because someone else is using it now.`);
            return;
        }

        // Check if this is a login error or a connection loss
        if (controller.nextacc == this.loginindex) { // Login error

            // Invalidate token to get a new session if this error was caused by an invalid refreshToken
            if (err.eresult == EResult.InvalidPassword || err.eresult == EResult.AccessDenied || err == "Error: InvalidSignature") { // These are the most likely enums that will occur when an invalid token was used I guess (Checking via String here as it seems like there are EResults missing)
                logger("debug", "Token login error: Calling SessionHandler's _invalidateTokenInStorage() function to get a new session when retrying this login attempt");

                if (err.eresult == EResult.AccessDenied) logger("warn", `[${this.logOnOptions.accountName}] Detected an AccessDenied login error! This is usually caused by an invalid login token. Deleting login token, please re-submit your Steam Guard code.`);

                this.session.invalidateTokenInStorage();

                setTimeout(() => this.login(), 5000);
                return;
            }

            logger("error", `[${this.logOnOptions.accountName}] Error logging in! ${err}. Continuing with next account...`);
            controller.nextacc++;
            controller.loginEvents.emit("nextacc", controller.nextacc);

        } else { // Connection loss

            // If error occurred during relog (aka logOn gave up because connection is still down), move account to the back of the queue and call handleRelog again
            if (controller.relogQueue.includes(this.loginindex)) {
                logger("warn", `[${this.logOnOptions.accountName}] Failed to relog. Repositioning to the back of the queue and trying again. ${err}`);
                controller.relogQueue.splice(0, 1);
            } else {
                logger("info", `[${this.logOnOptions.accountName}] Lost connection to Steam. ${err}. Trying to relog in ${this.acctConfig.relogDelay / 1000} seconds...`);
            }

            this.handleRelog();
        }
    });


    this.client.on("refreshToken", (newToken) => { // Emitted when refreshToken is auto-renewed by SteamUser
        logger("info", `[${this.logOnOptions.accountName}] SteamUser auto renewed this refresh token, updating database entry...`);

        this.session._saveTokenToStorage(newToken);
    });

};


/**
 * Handles relogging this bot account
 */
Bot.prototype.handleRelog = function() {
    if (controller.relogQueue.includes(this.loginindex)) return; // Don't handle this request if account is already waiting for relog

    // Call logPlaytime to print session results and reset startedPlayingTimestamp
    this.logPlaytimeToFile();

    // Add account to queue
    controller.relogQueue.push(this.loginindex);

    // Check if it's our turn to relog every 1 sec after waiting relogDelay ms
    setTimeout(() => {
        const relogInterval = setInterval(() => {
            if (controller.relogQueue.indexOf(this.loginindex) != 0) return; // Not our turn? stop and retry in the next iteration

            clearInterval(relogInterval); // Prevent any retries
            this.client.logOff();

            logger("info", `[${this.logOnOptions.accountName}] It is now my turn. Relogging in ${this.acctConfig.loginDelay / 1000} seconds...`);

            // Attach relogdelay timeout
            setTimeout(async () => {
                // Generate steamGuardCode with shared secret if one was provided
                if (this.logOnOptions.sharedSecret) {
                    this.logOnOptions.steamGuardCode = SteamTotp.generateAuthCode(this.logOnOptions.sharedSecret);
                }

                const refreshToken = await this.session.getToken();
                if (!refreshToken) return; // Stop execution if getToken aborted login attempt

                logger("info", `[${this.logOnOptions.accountName}] Logging in...`);

                this.client.logOn({ "refreshToken": refreshToken });
            }, this.acctConfig.loginDelay);
        }, 1000);
    }, this.acctConfig.relogDelay);
};


/**
 * Starts a 60-second interval that checks playtime goals and removes games that reached their target
 */
Bot.prototype.startGoalCheck = function() {
    if (this.goalCheckInterval) clearInterval(this.goalCheckInterval);
    this.goalCheckInterval = setInterval(() => {
        let goals = this.acctConfig.playtimeGoals;
        try {
            const cfg = JSON.parse(readSecure(path.join(dataDir, "config.json")));
            const acctCfg = (cfg.accountSettings && cfg.accountSettings[this.logOnOptions.accountName]) || {};
            goals = acctCfg.playtimeGoals || {};
            this.acctConfig.playtimeGoals = goals;
        } catch (e) { /* use existing */ }
        if (!goals || Object.keys(goals).length === 0) return;
        if (!this.playedAppIDs || this.playedAppIDs.length === 0) return;
        if (!this.client.steamID) return;

        const sessionHours = this.startedPlayingTimestamp > 0
            ? (Date.now() - this.startedPlayingTimestamp) / 3600000
            : 0;

        const removed = [];
        for (const [appidStr, targetHours] of Object.entries(goals)) {
            const appid = parseInt(appidStr);
            if (!this.playedAppIDs.includes(appid)) continue;
            const owned = (this.ownedGames || []).find(g => g.appid === appid);
            const lifetimeMinutes = owned ? owned.playtimeForever : 0;
            const currentHours = (lifetimeMinutes / 60) + sessionHours;
            if (currentHours >= targetHours) {
                removed.push({ appid, name: owned ? owned.name : "App " + appid, target: targetHours });
            }
        }

        if (removed.length === 0) return;

        let remaining = this.playedAppIDs.filter(id => !removed.find(r => r.appid === id));
        removed.forEach(r => {
            logger("info", `[${this.logOnOptions.accountName}] Playtime goal reached for ${r.name} (${r.target}h) -- stopped idling`);
        });

        this.playedAppIDs = remaining;
        this.client.gamesPlayed(remaining);

        try {
            const cfg = JSON.parse(readSecure(path.join(dataDir, "config.json")));
            if (cfg.accountSettings && cfg.accountSettings[this.logOnOptions.accountName]) {
                const acctCfg = cfg.accountSettings[this.logOnOptions.accountName];
                if (acctCfg.playingGames) {
                    acctCfg.playingGames = acctCfg.playingGames.filter(id => !removed.find(r => r.appid === id));
                }
                writeSecure(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 4) + "\n");
            }
        } catch (e) { /* ignore config write errors */ }

        if (remaining.length === 0) {
            this.logPlaytimeToFile();
        }
    }, 60000);
};

Bot.prototype.stopGoalCheck = function() {
    if (this.goalCheckInterval) {
        clearInterval(this.goalCheckInterval);
        this.goalCheckInterval = null;
    }
};

/**
 * Updates the games being played live without restarting the bot
 * @param {Array} games Array of appids and/or custom game name strings
 */
Bot.prototype.setGamesPlayed = function(games) {
    if (!this.client.steamID) return;
    this.client.gamesPlayed(games);
    this.playedAppIDs = games;
    if (games.length > 0 && this.startedPlayingTimestamp === 0) {
        this.startedPlayingTimestamp = Date.now();
    } else if (games.length === 0) {
        this.logPlaytimeToFile();
    }
    this.startGoalCheck();
};


/**
 * Returns the current status of this bot for the web dashboard
 */
Bot.prototype.getStatus = function() {
    let state = "offline";
    if (this.client.steamID) {
        state = this.startedPlayingTimestamp > 0 ? "playing" : "online";
    } else if (controller.relogQueue.includes(this.loginindex)) {
        state = "reconnecting";
    }

    const playtimeSeconds = this.startedPlayingTimestamp > 0
        ? Math.trunc((Date.now() - this.startedPlayingTimestamp) / 1000)
        : 0;

    const gameNames = (this.playedAppIDs || []).map(id => {
        if (typeof id === "string") return id;
        const g = (this.ownedGames || []).find(x => x.appid === id);
        return g ? g.name : "App " + id;
    });

    return {
        username: this.logOnOptions.accountName,
        state,
        games: this.playedAppIDs || [],
        gameNames,
        playtimeSeconds,
        proxy: this.proxy || "local"
    };
};


// Logs playtime to playtime.txt file
Bot.prototype.logPlaytimeToFile = function() {

    if (this.acctConfig.logPlaytimeToFile && this.startedPlayingTimestamp != 0) { // If timestamp is 0 then this was already logged
        logger("debug", `Logging playtime for '${this.logOnOptions.accountName}' to playtime.txt...`);

        // Helper function to convert timestamp into iso date string
        const formatDate = (timestamp) => (new Date(timestamp - (new Date().getTimezoneOffset() * 60000))).toISOString().replace(/T/, " ").replace(/\..+/, "");

        // Append session summary to playtime.txt
        const str = `[${this.logOnOptions.accountName}] Session Summary (${formatDate(this.startedPlayingTimestamp)} - ${formatDate(Date.now())}) ~ Played for ${Math.trunc((Date.now() - this.startedPlayingTimestamp) / 1000)} seconds: ${util.inspect(this.playedAppIDs, false, 2, false)}`; // Inspect() formats array properly

        fs.appendFile(path.join(dataDir, "playtime.txt"), str + "\n", (err) => {
            if (err) logger("warn", `[${this.logOnOptions.accountName}] Failed to write playtime: ${err.message}`);
        });
    }

    // Reset startedPlayingTimestamp
    this.startedPlayingTimestamp = 0;
    this.playedAppIDs = [];

};
