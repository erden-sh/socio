// CI's egress proxy (.github/workflows/ci.yml): the only way out of the
// internal Docker network `pnpm install` runs on. It opens CONNECT tunnels
// to the `host:port` entries in EGRESS_ALLOW (registry.npmjs.org:443) and
// refuses everything else, plain HTTP included. It logs each target and decision,
// never headers or bodies. Trusted: under .github/, which coding sessions
// never push (CB-32).
import { createServer } from 'node:http';
import { connect } from 'node:net';

const allow = new Set(
    (process.env.EGRESS_ALLOW ?? '')
        .split(/[\s,]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
);
const port = Number(process.env.EGRESS_PORT ?? 3128);
const log = (decision, target) => console.log(`egress ${decision} ${JSON.stringify(target)}`);

const server = createServer((request, response) => {
    log('denied', `${request.method} ${request.url}`);
    response.writeHead(405, { Connection: 'close' });
    response.end('Only CONNECT to allowed hosts.\n');
});
server.on('connect', (request, client, head) => {
    const target = String(request.url ?? '').toLowerCase();
    const match = /^([a-z0-9.-]+):(\d{1,5})$/.exec(target);
    if (!match || !allow.has(target)) {
        log('denied', target);
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
    }
    log('allowed', target);
    const upstream = connect(Number(match[2]), match[1], () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
    });
    const close = () => {
        upstream.destroy();
        client.destroy();
    };
    upstream.on('error', () => {
        if (!client.writableEnded) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        close();
    });
    client.on('error', close);
});
server.listen(port, process.env.EGRESS_HOST ?? '0.0.0.0', () =>
    console.log(`egress proxy on :${server.address().port}, allowing ${[...allow].join(' ')}`),
);
