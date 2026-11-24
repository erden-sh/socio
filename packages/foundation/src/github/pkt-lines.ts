/**
 * Git's pkt-line framing: moved from `src/server/github/api.ts`, which
 * re-exports it, so the coding gateway's Git proxy can frame lines without
 * importing the GitHub feature.
 */

/** One pkt-line: four hex digits of length (their own included), then data. */
export function pktLine(text: string) {
    const data = Buffer.from(text, 'utf8');
    return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii'), data]);
}

/** pkt-lines as text; null for a flush. Stops at the first malformed one. */
export function readPktLines(bytes: Uint8Array) {
    const buffer = Buffer.from(bytes);
    const lines: (string | null)[] = [];
    for (let at = 0; at + 4 <= buffer.length;) {
        const length = Number.parseInt(buffer.toString('ascii', at, at + 4), 16);
        if (!Number.isInteger(length) || (length > 0 && length < 4)) {
            break;
        }
        if (length === 0) {
            lines.push(null);
            at += 4;
            continue;
        }
        if (at + length > buffer.length) {
            break;
        }
        lines.push(buffer.toString('utf8', at + 4, at + length));
        at += length;
    }
    return lines;
}
