// A preload for servers.mjs's restart with another server version (`POST /restart?version=B:0.53.0`):
// the workspace server reports `SOCIO_E2E_SERVER_VERSION` wherever it reports its own (`/api/state`'s
// `version`, the workspace manifest, `/api/releases`), as an older or newer build would, so a flow can
// show the app's "needs a server update" banner for one workspace while another keeps working (CB-553).
// The server reads its version once, from the build's `releases.json` (src/server/updates/releases.ts);
// this answers that read with the version replaced. Only servers.mjs loads it, for local servers
// holding made-up accounts.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

/**
 * `readFileSync` with the version in any `releases.json` it reads replaced by `version`.
 * @param {typeof fs.readFileSync} read
 * @param {string} version
 * @returns {typeof fs.readFileSync}
 */
export function readingVersion(read, version) {
    return /** @type {typeof fs.readFileSync} */ (
        function (/** @type {any} */ path, /** @type {any} */ options) {
            const result = read(path, options);
            const name = path instanceof URL ? path.pathname : typeof path === 'string' ? path : '';
            if (!name.endsWith('/releases.json')) {
                return result;
            }
            const text = typeof result === 'string' ? result : result.toString('utf8');
            const replaced = JSON.stringify({ ...JSON.parse(text), version });
            return typeof result === 'string' ? replaced : Buffer.from(replaced);
        }
    );
}

const version = process.env.SOCIO_E2E_SERVER_VERSION;
if (version) {
    fs.readFileSync = readingVersion(fs.readFileSync, version);
    // The server imports `readFileSync` by name: carry the change into the ES module's export.
    syncBuiltinESMExports();
}
