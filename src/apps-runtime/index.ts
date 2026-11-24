// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { serve } from '@hono/node-server';

import { loadSecretFiles } from '@socio/foundation/keys/secret-files';
import { setPluginNamePrefix } from '@socio/shared/plugins/plugin-service';

import { runtimeApp } from './api.js';
import { dockerServicesFromEnv, runtimeConfigFromEnv } from './config.js';
import { HttpDockerEngine } from './docker.js';
import { LocalIdentityDelivery, SwarmIdentityDelivery } from './identity-delivery.js';
import { ingressServer } from './ingress.js';
import { PluginServices } from './services.js';
import { AppsSupervisor } from './supervisor.js';

// The workspace app runtime: runs promoted mini apps, one process
// each. Only the app calls its API; requests to apps come in through the
// ingress. Nothing it holds is durable: the app deploys again after a
// restart.
loadSecretFiles(process.env, undefined, ['APPS_RUNTIME_TOKEN']);
// Plugin services, networks and volumes are named with this prefix; the
// socket proxy enforces the same one (CB-327).
setPluginNamePrefix(process.env.PLUGIN_NAME_PREFIX);
const config = runtimeConfigFromEnv(process.env);
delete process.env.APPS_RUNTIME_TOKEN;
// Sockets and files apps make stay usable for this process's group, and
// nothing is readable by others (other apps).
process.umask(0o007);
const supervisor = new AppsSupervisor(config);
supervisor.init();
const docker = dockerServicesFromEnv(process.env);
const engine = docker ? new HttpDockerEngine(docker.socketPath, docker.pull) : undefined;
const services = docker
    ? new PluginServices(engine!, {
          allow: docker.allow,
          maxReplicas: docker.maxReplicas,
          secret: config.token,
          pull: docker.pull,
          buildRoot: docker.buildRoot,
          imageTag: docker.imageTag,
          pins: docker.pins,
          requireDigest: docker.requireDigest,
          constraints: docker.constraints,
          infraServices: docker.infraServices,
          egressService: docker.egressService,
          egressProxy: config.egressProxy,
          secretNames: docker.secretNames,
          // Each plugin's own identity token.
          identity:
              docker.identity.kind === 'local'
                  ? new LocalIdentityDelivery(docker.identity.dir)
                  : new SwarmIdentityDelivery(engine!),
          log: (line) => console.log(line),
      })
    : undefined;
const host = process.env.APPS_RUNTIME_HOST ?? '127.0.0.1';
const port = Number(process.env.APPS_RUNTIME_PORT ?? 4330);
const ingressPort = Number(process.env.APPS_RUNTIME_INGRESS_PORT ?? 4331);
const api = serve(
    {
        fetch: runtimeApp(supervisor, config.token, Math.ceil(config.bundleLimits.maxBytes * 1.5), services).fetch,
        hostname: host,
        port,
    },
    (info) => console.log(`Apps runtime API listening on ${host}:${info.port}`),
);
const ingress = ingressServer(supervisor, config.token, services);
ingress.listen(ingressPort, host, () => console.log(`Apps runtime ingress listening on ${host}:${ingressPort}`));
if (!config.isolate) {
    console.log('Apps runtime: APPS_RUNTIME_UID_BASE is not set, so apps run as this process’s user');
}
if (!config.egressProxy) {
    console.log('Apps runtime: no APPS_RUNTIME_EGRESS_PROXY, so apps reach nothing outside');
}
if (services) {
    console.log('Apps runtime: plugin services use Docker (APPS_RUNTIME_DOCKER=on).');
}
const shutdown = () => {
    const exit = setTimeout(() => process.exit(0), 10_000);
    exit.unref();
    void supervisor.stopAll().then(() => {
        ingress.close();
        api.close(() => process.exit(0));
    });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
