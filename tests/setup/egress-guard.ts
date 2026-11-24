// Tests import server modules directly, not through the server entry, so
// load the same vendor-telemetry opt-out before any SDK module.
import '@socio/foundation/no-vendor-telemetry';
import net from 'node:net';

import { afterEach } from 'vitest';

// Tests must never reach the network. Every outbound TCP connection (fetch,
// http/https, TLS and SDK clients all go through net.Socket#connect) is
// refused unless it targets loopback, and any attempt fails the test that
// made it. Unix sockets are allowed. Tests that stub fetch never get here.
const attempts: string[] = [];
const isLoopback = (host: string) =>
    host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');

type ConnectArgs = Parameters<net.Socket['connect']>;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: ConnectArgs) {
    // net.connect passes its normalized [options, callback] pair as one array.
    const list: unknown[] = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    const first = list[0];
    const target =
        typeof first === 'object' && first !== null
            ? (first as {
                  host?: string;
                  port?: number | string;
                  path?: string;
                  lookup?: net.LookupFunction;
              })
            : typeof first === 'number' || /^\d+$/.test(String(first))
              ? { port: first as number, host: list[1] as string | undefined }
              : { path: String(first) };
    if (!target.path) {
        const host = target.host ?? 'localhost';
        const lookup = 'lookup' in target ? target.lookup : undefined;
        if (lookup && !isLoopback(host)) {
            // DNS-pinned clients resolve names themselves; judge the pinned address.
            const destination = `${host}:${target.port ?? '?'}`;
            (target as { lookup: net.LookupFunction }).lookup = (hostname, options, callback) =>
                lookup(hostname, options, (error, address, family) => {
                    const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
                    if (!error && !addresses.every((entry) => isLoopback(entry))) {
                        attempts.push(`${destination} (${addresses.join(', ')})`);
                        callback(
                            new Error(`Test egress guard blocked a connection to ${destination}`),
                            address,
                            family,
                        );
                        return;
                    }
                    callback(error, address, family);
                });
        } else if (!isLoopback(host)) {
            const destination = `${host}:${target.port ?? '?'}`;
            attempts.push(destination);
            process.nextTick(() => this.destroy(new Error(`Test egress guard blocked a connection to ${destination}`)));
            return this;
        }
    }
    return connect.apply(this, args);
} as typeof net.Socket.prototype.connect;

/** For the guard's own tests: returns and clears recorded attempts. */
export function takeEgressAttempts() {
    return attempts.splice(0);
}

afterEach(() => {
    if (!attempts.length) {
        return;
    }
    const blocked = [...new Set(attempts.splice(0))].join(', ');
    throw new Error(`Test attempted network egress to: ${blocked}`);
});
