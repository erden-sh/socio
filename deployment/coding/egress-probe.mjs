// The coding sandbox's egress probe (CB-239). The computer supervisor runs it as its start-up self-test, in a
// canary sandbox built from the same fixed spec as every other, and creates
// no sandboxes unless it reports that nothing resolved and nothing answered.
//
//   node egress-probe.mjs <network gateway address> <egress proxy address>
//
// It tries outside names through the system resolver and public resolvers
// directly, public IPv4 and IPv6 addresses, the network's gateway (the
// host) on common ports, and a CONNECT tunnel through the egress proxy.
// Each attempt that succeeds is a failure. One JSON line on stdout.
import { lookup as dnsLookup, Resolver } from 'node:dns/promises';
import { connect as netConnect } from 'node:net';
import { pathToFileURL } from 'node:url';

export const OUTSIDE_NAMES = ['example.com', 'registry.npmjs.org', 'api.openai.com', 'github.com'];
export const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];
export const PUBLIC_TARGETS = [
    ['1.1.1.1', 443],
    ['8.8.8.8', 53],
    ['9.9.9.9', 443],
    ['140.82.112.3', 443],
    ['2606:4700:4700::1111', 443],
    ['2001:4860:4860::8888', 443],
];
export const GATEWAY_PORTS = [22, 53, 80, 443, 2375, 2376, 3128, 4300, 4310, 4340, 9000];

const within = (promise, ms) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

/** Whether a TCP connection opens within the time limit. */
export function tcpOpens(host, port, ms = 3000) {
    return new Promise((resolve) => {
        const socket = netConnect({ host, port });
        const done = (open) => {
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(ms, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/** Whether the proxy answers a CONNECT with 200 (it must never). */
export function tunnelOpens(proxy, port = 3128, ms = 3000) {
    return new Promise((resolve) => {
        const socket = netConnect({ host: proxy, port });
        let received = '';
        const done = (open) => {
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(ms, () => done(false));
        socket.once('error', () => done(false));
        socket.on('data', (data) => {
            received += data.toString();
            if (received.includes('\r\n')) done(/^HTTP\/1\.[01] 200/.test(received));
        });
        socket.once('connect', () => socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'));
    });
}

/**
 * Runs every check with the given network functions (the tests pass fakes;
 * nothing here runs outside a sandbox otherwise).
 */
export async function runProbe({
    gateway,
    proxy,
    lookup = (name) => dnsLookup(name, { all: true }),
    resolveWith = (server, name) => {
        const resolver = new Resolver({ timeout: 2000, tries: 1 });
        resolver.setServers([server]);
        return resolver.resolve4(name);
    },
    opens = tcpOpens,
    tunnel = tunnelOpens,
}) {
    const resolved = [];
    const reached = [];
    await Promise.all([
        ...OUTSIDE_NAMES.map(async (name) => {
            const answer = await within(lookup(name), 5000).catch(() => []);
            if (Array.isArray(answer) && answer.length) resolved.push(name);
        }),
        ...PUBLIC_RESOLVERS.map(async (server) => {
            const answer = await within(resolveWith(server, 'example.com'), 5000).catch(() => []);
            if (Array.isArray(answer) && answer.length) resolved.push(`example.com via ${server}`);
        }),
        ...PUBLIC_TARGETS.map(async ([host, port]) => {
            if (await opens(host, port)) reached.push(`${host}:${port}`);
        }),
        ...(gateway
            ? GATEWAY_PORTS.map(async (port) => {
                  if (await opens(gateway, port)) reached.push(`gateway:${port}`);
              })
            : []),
    ]);
    const tunnelled = proxy ? await tunnel(proxy) : false;
    return {
        probe: 'socio-egress-probe',
        v: 1,
        resolved: resolved.sort(),
        reached: reached.sort(),
        tunnel: tunnelled,
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [gateway, proxy] = process.argv.slice(2);
    const report = await runProbe({ gateway, proxy });
    process.stdout.write(`${JSON.stringify(report)}\n`);
}
