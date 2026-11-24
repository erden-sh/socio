// Preload that logs every outbound TCP connection the process opens:
//   node --import ./scripts/egress-log.mjs --import tsx src/server/index.ts
// Each line on stderr is "[egress] host:port". Loopback is logged too, so the
// output is a complete list of network destinations for an audit run.
import net from 'node:net';

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const list = Array.isArray(args[0]) ? args[0] : args;
    const first = list[0];
    const target =
        typeof first === 'object' && first !== null
            ? first
            : typeof first === 'number' || /^\d+$/.test(String(first))
              ? { port: first, host: list[1] }
              : { path: String(first) };
    if (!target.path) {
        process.stderr.write(`[egress] ${target.host ?? 'localhost'}:${target.port ?? '?'}\n`);
    }
    return connect.apply(this, args);
};
