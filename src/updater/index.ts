// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { serve } from '@hono/node-server';

import { loadSecretFiles } from '@socio/foundation/keys/secret-files';

import { updaterApp } from './app.js';
import { UPDATER_SECRET_SETTINGS, updaterConfigFromEnv } from './config.js';
import { createPlatform } from './platforms.js';
import { Updater } from './updater.js';

// The updater sidecar (CB-259): applies an update the app hands it, through
// the platform UPDATER_PLATFORM names (CB-323; the Portainer stack API by
// default), and rolls back when the new version isn't healthy. Opt-in, in
// a stack of its own, so an app update never replaces it mid-way.
loadSecretFiles(process.env, undefined, UPDATER_SECRET_SETTINGS);
const config = updaterConfigFromEnv(process.env);
for (const name of UPDATER_SECRET_SETTINGS) {
    delete process.env[name];
}
const updater = new Updater({ config, platform: createPlatform(config) });
updater.recover();
const server = serve(
    {
        fetch: updaterApp(updater, config.token).fetch,
        hostname: config.host,
        port: config.port,
    },
    (info) => console.log(`Updater listening on ${config.host}:${info.port}; it updates ${updater.target}.`),
);
// An update going on is kept on disk: the next start carries it on.
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
