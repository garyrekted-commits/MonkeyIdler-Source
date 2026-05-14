/*
 * File: handle2FA.js
 * Project: steam-idler
 * Created Date: 2022-10-09 12:59:31
 * Author: 3urobeat
 *
 * Last Modified: 2026-01-14 21:30:14
 * Modified By: 3urobeat
 *
 * Copyright (c) 2022 - 2026 3urobeat <https://github.com/3urobeat>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 * You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
 */


const SteamSession = require("steam-session"); // Only needed for the enum definitions below
const qrcode       = require("qrcode");
const { StartSessionResponse } = require("steam-session/dist/interfaces-external.js"); // eslint-disable-line

const sessionHandler = require("../sessionHandler.js");


/**
 * Internal: Handles submitting 2FA code
 * @param {StartSessionResponse} res Response object from startWithCredentials() promise
 */
sessionHandler.prototype._handle2FA = function(res) {
    logger("debug", `[${this.logOnOptions.accountName}] _handle2FA(): Received startWithCredentials() actionRequired response. Type: ${res.validActions[0].type} | Detail: ${res.validActions[0].detail}`);

    // Get 2FA code/prompt confirmation from user, mentioning the correct source
    switch (res.validActions[0].type) {
        case SteamSession.EAuthSessionGuardType.EmailCode:          // Type 2
            logger("info", `Please enter the Steam Guard Code from your email address at ${res.validActions[0].detail}. Skipping automatically in 1.5 minutes if you don't respond...`, true);

            this._get2FAUserInput();
            break;

        case SteamSession.EAuthSessionGuardType.DeviceConfirmation: // Type 4 (more convenient than type 3, both can be active at the same time so we check for this one first)
            logger("info", "Please confirm this login request in your Steam Mobile App.", false, false, logger.animation("waiting"));
            break;

        case SteamSession.EAuthSessionGuardType.DeviceCode:         // Type 3
            logger("info", "Please enter the Steam Guard Code from your Steam Mobile App. Skipping automatically in 1.5 minutes if you don't respond...", true);

            this._get2FAUserInput();
            break;

        case SteamSession.EAuthSessionGuardType.EmailConfirmation:  // Type 5
            logger("info", "Please confirm this login request via the confirmation email sent to you.", false, false, logger.animation("waiting"));
            break;

        default: // Dunno what to do with the other types
            logger("error", `Failed to get login session! Unexpected 2FA type ${res.validActions[0].type} for account '${this.logOnOptions.accountName}'! Sorry, I need to skip this account...`);

            this._resolvePromise(null);
            return;
    }
};


// Helper function to get 2FA code from user -- routes through the web dashboard UI
sessionHandler.prototype._get2FAUserInput = function() {

    // Register a pending code request that the web UI can fulfill
    try {
        const server = require("../../web/server.js");
        const accountName = this.logOnOptions.accountName;

        server.requestSteamGuardCode(accountName, (code) => {
            if (!code || code === "") {
                logger("info", `[${accountName}] Steam Guard skipped from dashboard.`, false, true);
                this._resolvePromise(null);
            } else if (code === "Login request accepted") {
                return; // Mobile app confirmation handled by authenticated event
            } else {
                logger("info", `[${accountName}] Accepting Steam Guard Code from dashboard...`, false, true);
                this._acceptSteamGuardCode(code.toString().trim());
            }
        });

        // Auto-skip after 3 minutes if no response
        setTimeout(() => {
            if (server.hasPendingCode(accountName)) {
                logger("info", `[${accountName}] No Steam Guard code received within 3 minutes, skipping...`, true);
                server.cancelPendingCode(accountName);
                this._resolvePromise(null);
            }
        }, 180000);
    } catch (e) {
        // Fallback to console if web server not available
        const question = `[${this.logOnOptions.accountName}] Steam Guard Code (leave empty and press ENTER to skip account): `;
        logger.readInput(question, 90000, (text) => {
            if (!text || text == "") {
                this._resolvePromise(null);
            } else if (text == "Login request accepted") {
                return;
            } else {
                this._acceptSteamGuardCode(text.toString().trim());
            }
        });
    }
};


/**
 * Internal: Helper function to make accepting and re-requesting invalid steam guard codes easier
 * @param {string} code Input from user
 */
sessionHandler.prototype._acceptSteamGuardCode = function(code) {

    this.session.submitSteamGuardCode(code)
        .then(() => { // Success
            logger("debug", `[${this.logOnOptions.accountName}] acceptSteamGuardCode(): User supplied correct code, authenticated event should trigger.`);
        })
        .catch((err) => { // Invalid code, ask again
            logger("warn", `Your code seems to be wrong, please try again or skip this account! ${err}`);

            // Skip account if account got temp blocked
            if (err.eresult == SteamSession.EResult.RateLimitExceeded || err.eresult == SteamSession.EResult.AccountLoginDeniedThrottle || err.eresult == SteamSession.EResult.AccessDenied) {
                logger("error", `[${this.logOnOptions.accountName}] Steam rejected our login and applied a temporary login cooldown! ${err}`);
                this.session.cancelLoginAttempt();
                this._resolvePromise(null);
                return;
            }

            // Ask user again
            this._get2FAUserInput();
        });

};


/**
 * Handles displaying a QR Code to login using the Steam Mobile App
 * @param {StartSessionResponse} res Response object from startWithQR() promise
 */
sessionHandler.prototype._handleQRCode = function(res) {

    // Display QR Code using qrcode library
    qrcode.toString(res.qrChallengeUrl, (err, string) => {
        if (err) {
            logger("error", `[${this.logOnOptions.accountName}] Failed to display QR Code! Is the URL '${res.qrChallengeUrl}' invalid? ${err}`);
            return this._resolvePromise(null);
        }

        logger("info", `[${this.logOnOptions.accountName}] Scan the following QR Code using your Steam Mobile App to start a new session:\n${string}`, true);

        // Also send QR URL to dashboard for display
        try {
            const server = require("../../web/server.js");
            server.broadcastLog({ type: "qrcode", message: `QR Code login for ${this.logOnOptions.accountName}`, url: res.qrChallengeUrl, account: this.logOnOptions.accountName, timestamp: Date.now() });
        } catch (e) { /* server not loaded */ }

        // Quick hack to prevent other messages from logging and pushing the QRCode up
        logger.readInput("", 90000, () => {});
    });

};
