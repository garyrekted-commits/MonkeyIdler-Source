#!/usr/bin/env node
/**
 * electron-builder sometimes creates a second GitHub release that only contains
 * MonkeyIdler-Setup.exe.blockmap. That release becomes /releases/latest and breaks
 * electron-updater (404 on latest.yml). Delete blockmap-only releases for this tag.
 */
const https = require("https");

const owner = "garyrekted-commits";
const repo = "MonkeyIdler-Source";
const token = process.env.GH_TOKEN;
const tag =
    (process.env.GITHUB_REF || "").replace(/^refs\/tags\//, "") ||
    process.argv[2] ||
    "";

if (!token) {
    console.error("GH_TOKEN is required");
    process.exit(1);
}

function api(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = https.request(
            {
                hostname: "api.github.com",
                path,
                method,
                headers: {
                    "User-Agent": "MonkeyIdler-release-fix",
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {})
                }
            },
            (res) => {
                let raw = "";
                res.on("data", (c) => { raw += c; });
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(raw ? JSON.parse(raw) : null);
                        return;
                    }
                    reject(new Error(`${method} ${path} → ${res.statusCode}: ${raw}`));
                });
            }
        );
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });
}

function isBlockmapOnlyRelease(release) {
    const assets = release.assets || [];
    if (!assets.length) return false;
    return assets.every((a) => /\.blockmap$/i.test(a.name));
}

async function main() {
    const releases = await api("GET", `/repos/${owner}/${repo}/releases?per_page=30`);
    const matches = tag
        ? releases.filter((r) => r.tag_name === tag)
        : releases.filter((r) => isBlockmapOnlyRelease(r));

    for (const release of matches) {
        if (!isBlockmapOnlyRelease(release)) continue;
        console.log(`Deleting blockmap-only release #${release.id} (${release.tag_name || release.name})`);
        await api("DELETE", `/repos/${owner}/${repo}/releases/${release.id}`);
    }
    if (!matches.some(isBlockmapOnlyRelease)) {
        console.log("No blockmap-only duplicate release found.");
    }
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
