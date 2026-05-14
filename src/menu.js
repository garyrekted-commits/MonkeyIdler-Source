/*
 * File: menu.js
 * Project: steam-idler
 * Created Date: 2026-05-13
 *
 * Interactive CLI menu for managing accounts, settings, and starting the idler.
 */

const fs       = require("fs");
const readline = require("readline");

const configPath   = "./config.json";
const accountsPath = "./accounts.txt";


function loadConfig() {
    if (!fs.existsSync(configPath)) {
        const defaults = {
            playingGames: [],
            onlinestatus: 1,
            afkMessage: "",
            loginDelay: 2000,
            relogDelay: 15000,
            useLocalIP: true,
            logPlaytimeToFile: true,
            accountSettings: {}
        };
        fs.writeFileSync(configPath, JSON.stringify(defaults, null, 4));
        return defaults;
    }
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function saveConfig(config) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + "\n");
}

function loadAccounts() {
    if (!fs.existsSync(accountsPath)) return [];
    const lines = fs.readFileSync(accountsPath, "utf8").split("\n");
    const accounts = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("//")) continue;
        const parts = line.split(":");
        accounts.push({
            username: parts[0],
            password: parts[1] || "",
            sharedSecret: parts[2] || ""
        });
    }
    return accounts;
}

function saveAccounts(accounts) {
    const header = "//Comment: Add all accounts to idle below, one per line: username:password:shared_secret  (shared_secret is optional)\n//  Per-account settings (games, online status, afk message, etc.) can be configured in config.json under \"accountSettings\".";
    const lines = accounts.map(a => {
        let line = `${a.username}:${a.password}`;
        if (a.sharedSecret) line += `:${a.sharedSecret}`;
        return line;
    });
    fs.writeFileSync(accountsPath, header + "\n" + lines.join("\n") + "\n");
}


function createRL() {
    return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question) {
    return new Promise(resolve => rl.question(question, resolve));
}

function clearScreen() {
    process.stdout.write("\x1b[2J\x1b[H");
}


async function mainMenu() {
    const rl = createRL();

    let running = true;
    while (running) {
        clearScreen();
        const accounts = loadAccounts();
        const config = loadConfig();

        console.log("==============================================");
        console.log("         Steam Idler - Main Menu");
        console.log("==============================================");
        console.log("");
        console.log(`  Accounts loaded: ${accounts.length}`);
        console.log(`  Default games:   ${config.playingGames.length > 0 ? config.playingGames.join(", ") : "(none)"}`);
        console.log("");
        console.log("  [1] Manage Accounts");
        console.log("  [2] Global Settings");
        console.log("  [3] Per-Account Settings");
        console.log("  [4] Start Idling");
        console.log("  [5] Exit");
        console.log("");

        const choice = (await ask(rl, "  Choose an option: ")).trim();

        switch (choice) {
            case "1": await accountsMenu(rl); break;
            case "2": await globalSettingsMenu(rl); break;
            case "3": await perAccountMenu(rl); break;
            case "4":
                rl.close();
                running = false;
                return true; // signal to start idling
            case "5":
                rl.close();
                process.exit(0);
            default:
                console.log("  Invalid option.");
                await ask(rl, "  Press Enter to continue...");
        }
    }
}


async function accountsMenu(rl) {
    let back = false;
    while (!back) {
        clearScreen();
        const accounts = loadAccounts();

        console.log("==============================================");
        console.log("         Manage Accounts");
        console.log("==============================================");
        console.log("");

        if (accounts.length === 0) {
            console.log("  No accounts configured.");
        } else {
            accounts.forEach((a, i) => {
                const masked = a.password ? "*".repeat(Math.min(a.password.length, 8)) : "(no password)";
                const secret = a.sharedSecret ? " [has shared_secret]" : "";
                console.log(`  [${i + 1}] ${a.username} (${masked})${secret}`);
            });
        }

        console.log("");
        console.log("  [a] Add account");
        console.log("  [r] Remove account");
        console.log("  [b] Back");
        console.log("");

        const choice = (await ask(rl, "  Choose an option: ")).trim().toLowerCase();

        switch (choice) {
            case "a": {
                console.log("");
                const username = (await ask(rl, "  Username: ")).trim();
                if (!username) { console.log("  Cancelled."); await ask(rl, "  Press Enter to continue..."); break; }

                const password = (await ask(rl, "  Password (or 'qrcode' for QR login): ")).trim();
                const sharedSecret = (await ask(rl, "  Shared secret (optional, press Enter to skip): ")).trim();

                const accts = loadAccounts();
                if (accts.find(a => a.username === username)) {
                    console.log(`  Account '${username}' already exists.`);
                    await ask(rl, "  Press Enter to continue...");
                    break;
                }

                accts.push({ username, password, sharedSecret });
                saveAccounts(accts);
                console.log(`  Account '${username}' added!`);
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "r": {
                const accts = loadAccounts();
                if (accts.length === 0) {
                    console.log("  No accounts to remove.");
                    await ask(rl, "  Press Enter to continue...");
                    break;
                }
                const idx = (await ask(rl, "  Enter account number to remove: ")).trim();
                const num = parseInt(idx);
                if (isNaN(num) || num < 1 || num > accts.length) {
                    console.log("  Invalid selection.");
                    await ask(rl, "  Press Enter to continue...");
                    break;
                }
                const removed = accts.splice(num - 1, 1)[0];
                saveAccounts(accts);

                // Also remove per-account settings if they exist
                const config = loadConfig();
                if (config.accountSettings && config.accountSettings[removed.username]) {
                    delete config.accountSettings[removed.username];
                    saveConfig(config);
                }

                console.log(`  Removed '${removed.username}'.`);
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "b":
                back = true;
                break;
            default:
                console.log("  Invalid option.");
                await ask(rl, "  Press Enter to continue...");
        }
    }
}


async function globalSettingsMenu(rl) {
    let back = false;
    while (!back) {
        clearScreen();
        const config = loadConfig();

        console.log("==============================================");
        console.log("         Global Settings (defaults)");
        console.log("==============================================");
        console.log("");
        console.log(`  [1] Games to idle:     ${config.playingGames.length > 0 ? config.playingGames.join(", ") : "(none)"}`);
        console.log(`  [2] Online status:     ${formatStatus(config.onlinestatus)}`);
        console.log(`  [3] AFK message:       ${config.afkMessage || "(disabled)"}`);
        console.log(`  [4] Login delay:       ${config.loginDelay}ms`);
        console.log(`  [5] Relog delay:       ${config.relogDelay}ms`);
        console.log(`  [6] Use local IP:      ${config.useLocalIP}`);
        console.log(`  [7] Log playtime:      ${config.logPlaytimeToFile}`);
        console.log("");
        console.log("  [b] Back");
        console.log("");

        const choice = (await ask(rl, "  Choose a setting to edit: ")).trim().toLowerCase();

        switch (choice) {
            case "1": {
                console.log("");
                console.log("  Enter game App IDs and/or custom game names, comma-separated.");
                console.log("  Example: 730, 440, My Custom Game");
                console.log("  Leave empty to clear.");
                const input = (await ask(rl, "  Games: ")).trim();
                config.playingGames = parseGamesInput(input);
                saveConfig(config);
                console.log("  Saved!");
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "2": {
                console.log("");
                console.log("  0=Offline  1=Online  2=Busy  3=Away  4=Snooze  5=LookingToTrade  6=LookingToPlay  7=Invisible");
                const input = (await ask(rl, "  Status number: ")).trim();
                const num = parseInt(input);
                if (!isNaN(num) && num >= 0 && num <= 7) {
                    config.onlinestatus = num === 0 ? null : num;
                    saveConfig(config);
                    console.log("  Saved!");
                } else {
                    console.log("  Invalid status.");
                }
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "3": {
                console.log("");
                console.log("  Leave empty to disable auto-reply.");
                const input = (await ask(rl, "  AFK message: ")).trim();
                config.afkMessage = input;
                saveConfig(config);
                console.log("  Saved!");
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "4": {
                const input = (await ask(rl, "  Login delay (ms): ")).trim();
                const num = parseInt(input);
                if (!isNaN(num) && num >= 0) { config.loginDelay = num; saveConfig(config); console.log("  Saved!"); }
                else console.log("  Invalid number.");
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "5": {
                const input = (await ask(rl, "  Relog delay (ms): ")).trim();
                const num = parseInt(input);
                if (!isNaN(num) && num >= 0) { config.relogDelay = num; saveConfig(config); console.log("  Saved!"); }
                else console.log("  Invalid number.");
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "6": {
                config.useLocalIP = !config.useLocalIP;
                saveConfig(config);
                console.log(`  Toggled to ${config.useLocalIP}.`);
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "7": {
                config.logPlaytimeToFile = !config.logPlaytimeToFile;
                saveConfig(config);
                console.log(`  Toggled to ${config.logPlaytimeToFile}.`);
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "b":
                back = true;
                break;
            default:
                console.log("  Invalid option.");
                await ask(rl, "  Press Enter to continue...");
        }
    }
}


async function perAccountMenu(rl) {
    let back = false;
    while (!back) {
        clearScreen();
        const accounts = loadAccounts();
        const config = loadConfig();
        if (!config.accountSettings) config.accountSettings = {};

        console.log("==============================================");
        console.log("       Per-Account Settings (overrides)");
        console.log("==============================================");
        console.log("");

        if (accounts.length === 0) {
            console.log("  No accounts configured. Add accounts first.");
            console.log("");
            console.log("  [b] Back");
            console.log("");
            const choice = (await ask(rl, "  Choose an option: ")).trim().toLowerCase();
            if (choice === "b") back = true;
            continue;
        }

        accounts.forEach((a, i) => {
            const hasOverrides = config.accountSettings[a.username];
            const tag = hasOverrides ? " [custom]" : " [using defaults]";
            console.log(`  [${i + 1}] ${a.username}${tag}`);
        });
        console.log("");
        console.log("  [b] Back");
        console.log("");

        const choice = (await ask(rl, "  Select account number to configure: ")).trim().toLowerCase();

        if (choice === "b") { back = true; continue; }

        const idx = parseInt(choice);
        if (isNaN(idx) || idx < 1 || idx > accounts.length) {
            console.log("  Invalid selection.");
            await ask(rl, "  Press Enter to continue...");
            continue;
        }

        await editAccountSettings(rl, accounts[idx - 1].username);
    }
}


async function editAccountSettings(rl, username) {
    let back = false;
    while (!back) {
        clearScreen();
        const config = loadConfig();
        if (!config.accountSettings) config.accountSettings = {};
        const overrides = config.accountSettings[username] || {};

        console.log("==============================================");
        console.log(`       Settings for: ${username}`);
        console.log("==============================================");
        console.log("  (blank = using global default)");
        console.log("");
        console.log(`  [1] Games to idle:     ${overrides.playingGames ? overrides.playingGames.join(", ") : "(default: " + config.playingGames.join(", ") + ")"}`);
        console.log(`  [2] Online status:     ${overrides.onlinestatus !== undefined ? formatStatus(overrides.onlinestatus) : "(default: " + formatStatus(config.onlinestatus) + ")"}`);
        console.log(`  [3] AFK message:       ${overrides.afkMessage !== undefined ? (overrides.afkMessage || "(disabled)") : "(default: " + (config.afkMessage || "disabled") + ")"}`);
        console.log(`  [4] Login delay:       ${overrides.loginDelay !== undefined ? overrides.loginDelay + "ms" : "(default: " + config.loginDelay + "ms)"}`);
        console.log(`  [5] Relog delay:       ${overrides.relogDelay !== undefined ? overrides.relogDelay + "ms" : "(default: " + config.relogDelay + "ms)"}`);
        console.log("");
        console.log("  [c] Clear all overrides (use defaults)");
        console.log("  [b] Back");
        console.log("");

        const choice = (await ask(rl, "  Choose a setting to edit: ")).trim().toLowerCase();

        switch (choice) {
            case "1": {
                console.log("");
                console.log("  Enter game App IDs and/or custom game names, comma-separated.");
                console.log("  Example: 730, 440, My Custom Game");
                console.log("  Leave empty to use global default.");
                const input = (await ask(rl, "  Games: ")).trim();
                if (!input) {
                    deleteOverride(config, username, "playingGames");
                } else {
                    setOverride(config, username, "playingGames", parseGamesInput(input));
                }
                saveConfig(config);
                console.log("  Saved!");
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "2": {
                console.log("");
                console.log("  0=Offline  1=Online  2=Busy  3=Away  4=Snooze  5=LookingToTrade  6=LookingToPlay  7=Invisible");
                console.log("  Leave empty to use global default.");
                const input = (await ask(rl, "  Status number: ")).trim();
                if (!input) {
                    deleteOverride(config, username, "onlinestatus");
                } else {
                    const num = parseInt(input);
                    if (!isNaN(num) && num >= 0 && num <= 7) {
                        setOverride(config, username, "onlinestatus", num === 0 ? null : num);
                    } else {
                        console.log("  Invalid status.");
                    }
                }
                saveConfig(config);
                console.log("  Saved!");
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "3": {
                console.log("");
                console.log("  Leave empty to use global default. Type 'off' to disable for this account.");
                const input = (await ask(rl, "  AFK message: ")).trim();
                if (!input) {
                    deleteOverride(config, username, "afkMessage");
                } else if (input.toLowerCase() === "off") {
                    setOverride(config, username, "afkMessage", "");
                } else {
                    setOverride(config, username, "afkMessage", input);
                }
                saveConfig(config);
                console.log("  Saved!");
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "4": {
                const input = (await ask(rl, "  Login delay (ms, empty for default): ")).trim();
                if (!input) { deleteOverride(config, username, "loginDelay"); }
                else { const n = parseInt(input); if (!isNaN(n) && n >= 0) setOverride(config, username, "loginDelay", n); else console.log("  Invalid."); }
                saveConfig(config);
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "5": {
                const input = (await ask(rl, "  Relog delay (ms, empty for default): ")).trim();
                if (!input) { deleteOverride(config, username, "relogDelay"); }
                else { const n = parseInt(input); if (!isNaN(n) && n >= 0) setOverride(config, username, "relogDelay", n); else console.log("  Invalid."); }
                saveConfig(config);
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "c": {
                if (config.accountSettings[username]) {
                    delete config.accountSettings[username];
                    saveConfig(config);
                }
                console.log(`  Cleared all overrides for '${username}'.`);
                await ask(rl, "  Press Enter to continue...");
                break;
            }
            case "b":
                back = true;
                break;
            default:
                console.log("  Invalid option.");
                await ask(rl, "  Press Enter to continue...");
        }
    }
}


// --- Helpers ---

function setOverride(config, username, key, value) {
    if (!config.accountSettings) config.accountSettings = {};
    if (!config.accountSettings[username]) config.accountSettings[username] = {};
    config.accountSettings[username][key] = value;
}

function deleteOverride(config, username, key) {
    if (!config.accountSettings || !config.accountSettings[username]) return;
    delete config.accountSettings[username][key];
    if (Object.keys(config.accountSettings[username]).length === 0) {
        delete config.accountSettings[username];
    }
}

function parseGamesInput(input) {
    if (!input) return [];
    return input.split(",").map(s => s.trim()).filter(Boolean).map(s => {
        const num = parseInt(s);
        return isNaN(num) ? s : num;
    });
}

function formatStatus(status) {
    const names = { 0: "Offline", 1: "Online", 2: "Busy", 3: "Away", 4: "Snooze", 5: "LookingToTrade", 6: "LookingToPlay", 7: "Invisible" };
    if (status === null || status === undefined) return "Offline (null)";
    return `${status} (${names[status] || "Unknown"})`;
}


module.exports = { mainMenu };
