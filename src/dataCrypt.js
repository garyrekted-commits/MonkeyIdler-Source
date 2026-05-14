/*
 * AES-256-GCM encryption for user data files.
 * Key is derived from machine-specific info so data is only readable on the same machine/user.
 */

const crypto = require("crypto");
const os     = require("os");
const fs     = require("fs");

const MAGIC  = "MKIDL1"; // 6-byte header to identify encrypted files
const SALT   = "MonkeyIdler-v1-salt";

function deriveKey() {
    const seed = os.hostname() + "|" + os.userInfo().username + "|" + SALT;
    return crypto.pbkdf2Sync(seed, SALT, 100000, 32, "sha256");
}

let _key = null;
function getKey() {
    if (!_key) _key = deriveKey();
    return _key;
}

function encrypt(plaintext) {
    const key = getKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: MAGIC (6) + IV (12) + TAG (16) + ciphertext
    return Buffer.concat([Buffer.from(MAGIC, "ascii"), iv, tag, enc]);
}

function decrypt(buf) {
    const key = getKey();
    const iv  = buf.subarray(6, 18);
    const tag = buf.subarray(18, 34);
    const enc = buf.subarray(34);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc, null, "utf8") + decipher.final("utf8");
}

function isEncrypted(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 34) return false;
    return buf.subarray(0, 6).toString("ascii") === MAGIC;
}

/**
 * Read a file, decrypting if encrypted, returning plaintext string.
 */
function readSecure(filePath) {
    const buf = fs.readFileSync(filePath);
    if (isEncrypted(buf)) return decrypt(buf);
    return buf.toString("utf8");
}

/**
 * Write a file with encryption.
 */
function writeSecure(filePath, content) {
    fs.writeFileSync(filePath, encrypt(content));
}

/**
 * Migrate a plaintext file to encrypted (if it exists and isn't already encrypted).
 */
function migrateFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    const buf = fs.readFileSync(filePath);
    if (isEncrypted(buf)) return;
    if (buf.length === 0) return;
    fs.writeFileSync(filePath, encrypt(buf.toString("utf8")));
}

module.exports = { readSecure, writeSecure, migrateFile, isEncrypted };
