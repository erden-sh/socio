// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { setPluginNamePrefix } from '@socio/shared/plugins/plugin-service';

import {
    parseListen,
    parseImagePins,
    parsePluginConstraints,
    parseSecretNames,
    startSocketProxy,
} from './socket-proxy.js';

/**
 * The Docker socket proxy. The plugin overlay runs this and is the only
 * container that mounts `/var/run/docker.sock`. The apps runtime uses
 * `APPS_RUNTIME_DOCKER_HOST=tcp://docker-socket-proxy:2375`.
 */
// The same PLUGIN_NAME_PREFIX as the apps runtime's (CB-327).
const namePrefix = setPluginNamePrefix(process.env.PLUGIN_NAME_PREFIX);
const listen = parseListen(process.env.SOCKET_PROXY_LISTEN);
const pins = parseImagePins(process.env.SOCKET_PROXY_IMAGE_PINS);
const constraints = parsePluginConstraints(process.env.SOCKET_PROXY_PLUGIN_CONSTRAINTS);
const infra = new Set(
    (process.env.SOCKET_PROXY_INFRA_SERVICES ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
);
const secretNames = parseSecretNames(process.env.SOCKET_PROXY_SECRET_NAMES);
const proxy = startSocketProxy({
    listenHost: listen.host,
    listenPort: listen.port,
    upstream: process.env.SOCKET_PROXY_SOCKET?.trim() || '/var/run/docker.sock',
    pins,
    constraints,
    infra,
    secretNames,
});
void proxy.listen().then(() => {
    console.log(
        `Socket proxy listening on ${listen.host}:${listen.port} (plugin names ${namePrefix}-*, ${pins.size} image pin${pins.size === 1 ? '' : 's'}, ${constraints.length ? `placement ${constraints.join(', ')}` : 'no placement constraints'}, ${secretNames.size} secret name${secretNames.size === 1 ? '' : 's'}).`,
    );
});
