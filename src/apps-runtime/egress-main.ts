import { loadSecretFiles } from '@socio/foundation/keys/secret-files';

import { egressProxy } from '../egress/proxy.js';

import { egressTenant } from './keys.js';

// The promoted apps' egress proxy (a service of its own in the stack, on
// the apps' egress network and an outbound one): CONNECT only, each app to
// the hosts its manifest lists (named in its credentials, which the
// runtime signs), public addresses only. One log line per request: the
// app's id and host:port, never headers or bodies.
loadSecretFiles(process.env, undefined, ['APPS_RUNTIME_TOKEN']);
const secret = process.env.APPS_RUNTIME_TOKEN?.trim();
if (!secret || secret.length < 24) {
    throw new Error('APPS_RUNTIME_TOKEN must be at least 24 characters.');
}
delete process.env.APPS_RUNTIME_TOKEN;
const host = process.env.EGRESS_HOST ?? '127.0.0.1';
const port = Number(process.env.EGRESS_PORT ?? 3128);
const server = egressProxy({
    allow: [],
    tenant: egressTenant(secret),
    publicOnly: process.env.EGRESS_PUBLIC_ONLY !== 'false',
});
server.listen(port, host, () => console.log(`Apps egress proxy listening on ${host}:${port}`));
const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
