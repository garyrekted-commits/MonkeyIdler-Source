/*
 * File: controller.js
 * Project: steam-idler
 * Created Date: 2022-10-17 18:00:31
 * Author: 3urobeat
 *
 * Last Modified: 2026-01-14 21:47:28
 * Modified By: 3urobeat
 *
 * Copyright (c) 2022 - 2026 3urobeat <https://github.com/3urobeat>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 * You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
 */


// Handles creating bot objects, providing them with data and relogging
const fs     = require("fs");
const path   = require("path");
const logger = require("output-logger");
const EventEmitter = require("events");

const dataDir = global.dataDir || ".";
const { readSecure } = require("./dataCrypt.js");
let config = JSON.parse(readSecure(path.join(dataDir, "config.json")));

// Export both values to make them accessable from bot.js
module.exports.nextacc    = 0;
module.exports.relogQueue = []; // Queue tracking disconnected accounts to relog them after eachother with a delay

const loginEvents = new EventEmitter();
module.exports.loginEvents = loginEvents;

// Configure my logging lib
logger.options({
    msgstructure: `[${logger.Const.ANIMATION}] [${logger.Const.DATE} | ${logger.Const.TYPE}] ${logger.Const.MESSAGE}`,
    paramstructure: [logger.Const.TYPE, logger.Const.MESSAGE, "nodate", "remove", logger.Const.ANIMATION],
    outputfile: path.join(dataDir, "output.txt"),
    exitmessage: "Goodbye!",
    printdebug: false
});

// Hook into stdout to capture log output and forward to the web dashboard
const origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function(chunk, encoding, callback) {
    origStdoutWrite(chunk, encoding, callback);
    try {
        const server = require("./web/server.js");
        const str = typeof chunk === "string" ? chunk : chunk.toString();
        const trimmed = str.replace(/\r?\n$/, "").trim();
        if (trimmed) {
            let type = "info";
            if (/\| warn\]/i.test(trimmed)) type = "warn";
            else if (/\| error\]/i.test(trimmed)) type = "error";
            server.broadcastLog({ type, message: trimmed, timestamp: Date.now() });
        }
    } catch (e) { /* server not loaded yet */ }
};

// Broadcast bot status to connected dashboard clients every 3 seconds
setInterval(() => {
    try {
        const server = require("./web/server.js");
        if (module.exports.isRunning) server.broadcastStatus();
    } catch (e) { /* ignore */ }
}, 3000);


/**
 * Helper function to import login information from accounts.txt
 * @returns {Promise} logininfo object on success, bot is stopped on failure
 */
function importLogininfo() {
    return new Promise((resolve) => {
        logger("info", "Loading logininfo from accounts.txt...");

        let logininfo = {};

        // Import data from accounts.txt
        if (fs.existsSync(path.join(dataDir, "accounts.txt"))) {
            let data = readSecure(path.join(dataDir, "accounts.txt")).split("\n");

            if (data.length > 0 && data[0].startsWith("//Comment")) data = data.slice(1); // Remove comment from array

            if (data != "") {
                logininfo = {}; // Set empty object

                data.forEach((e) => {
                    if (e.length < 2) return; // If the line is empty ignore it to avoid issues like this: https://github.com/3urobeat/steam-comment-service-bot/issues/80
                    e = e.split(":");
                    e[e.length - 1] = e[e.length - 1].replace("\r", ""); // Remove Windows next line character from last index (which has to be the end of the line)

                    // Format logininfo object and use accountName as key to allow the order to change
                    logininfo[e[0]] = {
                        accountName: e[0],
                        password: e[1],
                        sharedSecret: e[2],
                        steamGuardCode: null
                    };
                });

                logger("info", `Found ${Object.keys(logininfo).length} accounts in accounts.txt, not checking for logininfo.json...`, false, true, logger.animation("loading"));

                return resolve(logininfo);
            } else {
                logger("error", "No accounts found in accounts.txt! Aborting...");
                process.exit(1);
            }
        } else {
            logger("error", "No accounts found in accounts.txt! Aborting...");
            process.exit(1);
        }
    });
}

/**
 * Helper functions to import proxies from proxies.txt
 * @returns {Promise} proxies array on completion
 */
function importProxies() {
    return new Promise((resolve) => {
        let proxies = []; // When the file is just created there can't be proxies in it (this bot doesn't support magic)

        if (!fs.existsSync(path.join(dataDir, "proxies.txt"))) {
            resolve([ null ]);
        } else {
            proxies = fs.readFileSync(path.join(dataDir, "proxies.txt"), "utf8").split("\n");
            proxies = proxies.filter(str => str != ""); // Remove empty lines

            if (proxies.length > 0 && proxies[0].startsWith("//Comment")) proxies = proxies.slice(1); // Remove comment from array

            if (config.useLocalIP) proxies.unshift(null); // Add no proxy (local ip) if useLocalIP is true

            // Check if no proxies were found (can only be the case when useLocalIP is false)
            if (proxies.length == 0) {
                logger("", "", true);
                logger("error", "useLocalIP is turned off in config.json but I couldn't find any proxies in proxies.txt!\n        Aborting as I don't have at least one IP to log in with!", true);
                return process.exit();
            }
        }

        resolve(proxies);
    });
}

/* ------------ Login all accounts ------------ */
const allBots = [];

module.exports.allBots   = allBots;
module.exports.isRunning = false;

/**
 * Returns status objects for all bots
 */
module.exports.getAllStatus = function() {
    return allBots.map(b => b.getStatus());
};

/**
 * Stops all bot instances and resets state
 */
module.exports.stop = function() {
    logger("info", "Stopping all bots...");
    allBots.forEach(b => {
        b.logPlaytimeToFile();
        try { b.client.logOff(); } catch (e) { /* ignore */ }
    });
    allBots.length = 0;
    module.exports.nextacc    = 0;
    module.exports.relogQueue = [];
    module.exports.isRunning  = false;
    logger("info", "All bots stopped.");
};

/**
 * Stops a single bot by username
 */
module.exports.stopOne = function(username) {
    const bot = allBots.find(b => b.logOnOptions.accountName === username);
    if (!bot) return false;
    logger("info", `Stopping bot '${username}'...`);
    bot.logPlaytimeToFile();
    try { bot.client.logOff(); } catch (e) { /* ignore */ }
    const idx = allBots.indexOf(bot);
    if (idx !== -1) allBots.splice(idx, 1);
    // Remove from relog queue if present
    const qi = module.exports.relogQueue.indexOf(bot.loginindex);
    if (qi !== -1) module.exports.relogQueue.splice(qi, 1);
    if (allBots.length === 0) module.exports.isRunning = false;
    logger("info", `Bot '${username}' stopped.`);
    return true;
};

/**
 * Starts a single bot by username (must already be in accounts.txt)
 */
module.exports.startOne = async function(username) {
    // Check if already running
    if (allBots.find(b => b.logOnOptions.accountName === username)) return false;

    config = JSON.parse(readSecure(path.join(dataDir, "config.json")));
    if (!global.logger) global.logger = logger;

    const logininfo = await importLogininfo();
    const entry = logininfo[username];
    if (!entry) return false;

    const proxies = await importProxies();
    const i = allBots.length;

    const acctOverrides = (config.accountSettings && config.accountSettings[username]) || {};
    const acctConfig = {
        playingGames:      acctOverrides.playingGames      ?? config.playingGames,
        onlinestatus:      acctOverrides.onlinestatus      ?? config.onlinestatus,
        afkMessage:        acctOverrides.afkMessage        ?? config.afkMessage,
        loginDelay:        acctOverrides.loginDelay        ?? config.loginDelay,
        relogDelay:        acctOverrides.relogDelay        ?? config.relogDelay,
        logPlaytimeToFile: acctOverrides.logPlaytimeToFile ?? config.logPlaytimeToFile,
        wasIdling:         acctOverrides.wasIdling === true
    };

    const botfile = require("./bot.js");
    const bot = new botfile(entry, i, proxies, acctConfig);
    module.exports.nextacc = i; // Allow this bot to proceed immediately
    bot.login();
    allBots.push(bot);
    module.exports.isRunning = true;
    return true;
};

module.exports.start = async () => {
    // Re-read config from disk in case the interactive menu changed it
    config = JSON.parse(readSecure(path.join(dataDir, "config.json")));

    module.exports.isRunning = true;

    global.logger = logger; // Make logger accessible from everywhere in this project

    logger("", "", true, true);
    logger("info", "steam-idler by 3urobeat v1.11\n");

    // Call helper function to import logininfo
    const logininfo = await importLogininfo();

    // Call helper function to import proxies
    const proxies = await importProxies();

    // Start creating a bot object for each account
    logger("", "", true);

    const entries = Object.values(logininfo);

    const loginAccount = (i) => {
        if (i >= entries.length) return;
        const e = entries[i];

        const proceed = () => {
            const acctOverrides = (config.accountSettings && config.accountSettings[e.accountName]) || {};
            const acctConfig = {
                playingGames:     acctOverrides.playingGames     ?? config.playingGames,
                onlinestatus:     acctOverrides.onlinestatus     ?? config.onlinestatus,
                afkMessage:       acctOverrides.afkMessage       ?? config.afkMessage,
                loginDelay:       acctOverrides.loginDelay       ?? config.loginDelay,
                relogDelay:       acctOverrides.relogDelay       ?? config.relogDelay,
                logPlaytimeToFile: acctOverrides.logPlaytimeToFile ?? config.logPlaytimeToFile,
                wasIdling:        acctOverrides.wasIdling === true
            };

            const botfile = require("./bot.js");
            const bot = new botfile(e, i, proxies, acctConfig);
            bot.login();
            allBots.push(bot);
        };

        if (this.nextacc >= i) {
            proceed();
        } else {
            const onNext = () => {
                if (module.exports.nextacc >= i) {
                    loginEvents.removeListener("nextacc", onNext);
                    proceed();
                }
            };
            loginEvents.on("nextacc", onNext);
        }
    };

    entries.forEach((_, i) => setTimeout(() => loginAccount(i), 1000));
};

// Log playtime for all accounts on exit
process.on("exit", () => {
    allBots.forEach((e) => e.logPlaytimeToFile());
});
