import { loadSecretFiles } from '@socio/foundation/keys/secret-files';

import { codingEgressDiagnostics, codingEgressProxy, DenialLog } from './proxy.js';

// The coding sandboxes' egress proxy (CB-239), a service of its own in
// the computers stack: on the gateway network (to Socio's internal gateway
// listener), an outbound network (to the registries), and every coding
// sandbox's network, which the computer supervisor connects it to. No
// CONNECT; the gateway route and read-only registry virtual hosts only.
// One log line per denial (sampled per minute for allowed requests): the
// sandbox id and host:port, never headers, bodies or addresses.
loadSecretFiles(process.env, undefined, ['CODING_EGRESS_SECRET']);
const secret = process.env.CODING_EGRESS_SECRET?.trim();
if (!secret || secret.length < 24) {
    throw new Error('CODING_EGRESS_SECRET must be at least 24 characters.');
}
delete process.env.CODING_EGRESS_SECRET;

// Which registry mechanism is in use. Only the read-only virtual hosts are
// built; the TLS-intercepting fallback is a documented switch
// (deployment/coding/README.md) that is refused until it is built and
// passes the same tests, rather than silently allowing CONNECT.
const mode = process.env.CODING_EGRESS_MODE?.trim() || 'virtual-hosts';
if (mode !== 'virtual-hosts') {
    throw new Error(
        `CODING_EGRESS_MODE=${mode.slice(0, 40)} is not available: only "virtual-hosts" is built (see deployment/coding/README.md, "Registry fallback").`,
    );
}

const gatewayUpstream = process.env.CODING_GATEWAY_UPSTREAM?.trim();
if (!gatewayUpstream) {
    throw new Error(
        'CODING_GATEWAY_UPSTREAM must name the internal gateway listener, e.g. http://company-brain-app:4340.',
    );
}
const host = process.env.CODING_EGRESS_HOST ?? '0.0.0.0';
const port = Number(process.env.CODING_EGRESS_PORT ?? 3128);
const diagnosticsPort = Number(process.env.CODING_EGRESS_DIAGNOSTICS_PORT ?? 3129);
const denials = new DenialLog();
const server = codingEgressProxy({ secret, gatewayUpstream, denials });
const diagnostics = codingEgressDiagnostics(secret, denials, {
    subnet: process.env.CODING_EGRESS_DIAGNOSTICS_SUBNET?.trim() || undefined,
});
server.listen(port, host, () =>
    console.log(`Coding egress proxy listening on ${host}:${port} (mode ${mode}); diagnostics on ${diagnosticsPort}`),
);
diagnostics.listen(diagnosticsPort, host);
const shutdown = () => {
    diagnostics.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
