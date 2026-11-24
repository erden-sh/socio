// A preload for servers.mjs's restart with the clock ahead (`POST /restart?ahead=<days>`):
// the server's Date, and so its sessions' expiry checks and its answers' Date header, that many days
// ahead of the machine's. A session the app holds is then past its expiry by the server's clock, as
// after a week away, and its next request gets the 401 of an expired session.
// Only servers.mjs loads it, for local servers holding made-up accounts.
import http from 'node:http';

/**
 * A Date class whose "now" (`new Date()`, `Date.now()`) is `ms` ahead of `RealDate`'s; a date built
 * from a value is that value.
 * @param {DateConstructor} RealDate
 * @param {number} ms
 * @returns {DateConstructor}
 */
export function dateAhead(RealDate, ms) {
    class DateAhead extends RealDate {
        /** @param {any[]} args */
        constructor(...args) {
            // @ts-ignore: Date's overloads take the arguments they were given.
            super(...(args.length === 0 ? [RealDate.now() + ms] : args));
        }

        static now() {
            return RealDate.now() + ms;
        }
    }
    return /** @type {DateConstructor} */ (/** @type {unknown} */ (DateAhead));
}

const ahead = Number(process.env.SOCIO_E2E_CLOCK_AHEAD_MS ?? '0');
if (Number.isFinite(ahead) && ahead !== 0) {
    globalThis.Date = dateAhead(Date, ahead);
    // Node's own Date header reads the real clock: set it from the shifted one first.
    const writeHead = http.ServerResponse.prototype.writeHead;
    http.ServerResponse.prototype.writeHead = /** @type {typeof writeHead} */ (
        function (/** @type {any[]} */ ...args) {
            if (!this.headersSent && !this.hasHeader('date')) {
                this.setHeader('date', new Date().toUTCString());
            }
            // @ts-ignore: writeHead's overloads take the arguments they were given.
            return writeHead.apply(this, args);
        }
    );
}
