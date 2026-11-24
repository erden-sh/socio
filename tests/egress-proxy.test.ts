import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import { afterEach, expect, it } from 'vitest';

import { egressProxy, parseAllowlist } from '../src/egress/proxy.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const listen = async (server: Server) => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise((resolve) => server.close(resolve)));
    return (server.address() as AddressInfo).port;
};

/** A local stand-in for the vendor API: echoes what it gets. */
async function echoServer() {
    const connections: number[] = [];
    const server = createServer((socket) => {
        connections.push(Date.now());
        socket.on('data', (data) => socket.write(`echo:${data}`));
    });
    return { port: await listen(server), connections };
}

async function proxy(allow: string[]) {
    const logs: string[] = [];
    const server = egressProxy({ allow, log: (line) => logs.push(line) });
    return { port: await listen(server), logs };
}

/** Sends raw bytes to the proxy; resolves with what came back. */
function exchange(port: number, request: string, after?: string) {
    return new Promise<string>((resolve) => {
        const socket = connect(port, '127.0.0.1');
        let received = '';
        socket.on('data', (data) => {
            received += data.toString();
            if (after && received.startsWith('HTTP/1.1 200')) {
                socket.write(after);
                after = undefined;
            } else if (received.includes('echo:')) {
                socket.end();
            }
        });
        socket.on('close', () => resolve(received));
        socket.on('error', () => resolve(received));
        socket.write(request);
    });
}

const CANARY = 'header-or-body-canary-91c2';

it('tunnels CONNECT to an allowed host and logs only host and port', async () => {
    const api = await echoServer();
    const target = `127.0.0.1:${api.port}`;
    const p = await proxy(parseAllowlist(`${target}, api.anthropic.com:443`));
    const received = await exchange(
        p.port,
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${CANARY}\r\nUser-Agent: ${CANARY}\r\n\r\n`,
        `tunnelled ${CANARY}`,
    );
    expect(received).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    expect(received).toContain(`echo:tunnelled ${CANARY}`);
    expect(api.connections).toHaveLength(1);
    expect(p.logs).toEqual([`egress-proxy: allowed CONNECT ${target}`]);
});

it('refuses other hosts and ports, plain HTTP and malformed targets without connecting', async () => {
    const other = await echoServer();
    const allowed = await echoServer();
    const p = await proxy([`127.0.0.1:${allowed.port}`]);
    for (const target of [
        `127.0.0.1:${other.port}`,
        `localhost:${allowed.port}`,
        'example.com:443',
        'api.anthropic.com:443',
    ]) {
        const received = await exchange(
            p.port,
            `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nX-Secret: ${CANARY}\r\n\r\n`,
        );
        expect(received, target).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    }
    const plain = await exchange(
        p.port,
        `POST http://example.com/upload?token=${CANARY} HTTP/1.1\r\nHost: example.com\r\nContent-Length: ${CANARY.length}\r\n\r\n${CANARY}`,
    );
    expect(plain).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    const odd = await exchange(p.port, `CONNECT ${CANARY}@evil\n:443 HTTP/1.1\r\n\r\n`);
    expect(odd).not.toMatch(/200 Connection Established/);
    expect(other.connections).toHaveLength(0);
    expect(allowed.connections).toHaveLength(0);
    expect(p.logs.slice(0, 5)).toEqual([
        `egress-proxy: denied CONNECT 127.0.0.1:${other.port}`,
        `egress-proxy: denied CONNECT localhost:${allowed.port}`,
        'egress-proxy: denied CONNECT example.com:443',
        'egress-proxy: denied CONNECT api.anthropic.com:443',
        'egress-proxy: denied POST example.com:80',
    ]);
    expect(p.logs.join('\n')).not.toContain(CANARY);
});

it('answers its health check and validates the allowlist', async () => {
    const p = await proxy([]);
    expect(await exchange(p.port, 'GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).toMatch(
        /^HTTP\/1\.1 200 OK[\s\S]*ok$/,
    );
    expect(p.logs).toEqual([]);
    expect(parseAllowlist(' API.Anthropic.com:443 ,api.openai.com:443')).toEqual([
        'api.anthropic.com:443',
        'api.openai.com:443',
    ]);
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(() => parseAllowlist('api.anthropic.com')).toThrow(/host:port/);
    expect(() => parseAllowlist('*.anthropic.com:443')).toThrow(/host:port/);
});

it('closes the upstream when the client resets during the name lookup (CB-150)', async () => {
    // Counts the tunnels still open at the allowed target.
    let open = 0;
    const sockets = new Set<Socket>();
    const site = createServer((socket) => {
        open++;
        sockets.add(socket);
        socket.on('close', () => open--);
        socket.on('error', () => {});
    });
    const sitePort = await listen(site);
    cleanup.push(() => sockets.forEach((socket) => socket.destroy()));
    const target = `allowed.example.com:${sitePort}`;
    let answer = () => {};
    const looking: Array<() => void> = [];
    const logs: string[] = [];
    const server = egressProxy({
        allow: [],
        tenant: () => ({ allow: new Set([target]), label: 'tracker--dot-ab12cd' }),
        publicOnly: true,
        // A slow resolver: answers once the test says so.
        lookup: () =>
            new Promise((resolve) => {
                answer = () => resolve([{ address: '127.0.0.1' }]);
                looking.shift()?.();
            }),
        isPublic: (address) => address === '127.0.0.1',
        log: (line) => logs.push(line),
    });
    const port = await listen(server);
    for (let round = 0; round < 5; round++) {
        const asked = new Promise<void>((resolve) => looking.push(resolve));
        const socket = connect(port, '127.0.0.1');
        const gone = new Promise((resolve) => socket.on('close', resolve));
        socket.on('error', () => {});
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
        await asked;
        socket.resetAndDestroy();
        await gone;
        await new Promise((resolve) => setTimeout(resolve, 20));
        answer();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(open).toBe(0);
    expect(logs).toHaveLength(5);
    expect(logs[0]).toBe(`egress-proxy: allowed CONNECT ${target} for tracker--dot-ab12cd`);
});

it('stays up when a refused client resets its connection (CB-149)', async () => {
    // Bun retries a failed download with a bare CONNECT (no credentials) and
    // drops the connection at once: the refusal must not take the proxy down.
    const plain = await proxy([]);
    const logs: string[] = [];
    const tenant = egressProxy({
        allow: [],
        tenant: () => undefined,
        log: (line) => logs.push(line),
    });
    const tenantPort = await listen(tenant);
    const reset = (port: number) =>
        new Promise<void>((resolve) => {
            const socket = connect(port, '127.0.0.1');
            socket.on('data', () => socket.resetAndDestroy());
            socket.on('close', () => resolve());
            socket.on('error', () => resolve());
            socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n');
        });
    for (let round = 0; round < 5; round++) {
        await reset(plain.port);
        await reset(tenantPort);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const port of [plain.port, tenantPort]) {
        expect(await exchange(port, 'GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).toMatch(
            /^HTTP\/1\.1 200 OK[\s\S]*ok$/,
        );
    }
    expect(logs).toHaveLength(5);
    expect(logs[0]).toBe('egress-proxy: denied CONNECT example.com:443 (no credentials)');
});
