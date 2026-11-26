import { downgradeAttachmentParts, READS_HEADER, readsAgUiMedia } from './refs.js';

/*
 * COMPAT(ag-ui-1.0): responses for the native app builds already shipped
 * (0.2.6 and earlier), which read attachments only as the pre-1.0 `binary`
 * reference (`downgradeAttachmentParts`). A request that sends
 * `X-Socio-Reads: ag-ui-media` (every client since 1.0) gets what the server
 * stores. Remove this file once no supported build is 0.2.6 or older.
 * Web-standard APIs only: the server uses it, nothing else needs to.
 */

/** Whether a request's client reads only the pre-1.0 attachment shape: it sent no `ag-ui-media`. */
export const wantsLegacyMedia = (headers: Headers) => !readsAgUiMedia(headers.get(READS_HEADER));

/** A JSON body as such a client reads it. */
export const legacyMediaJson = <T>(body: T): T => downgradeAttachmentParts(body);

// Only a frame that names Socio's provider can hold an attachment part.
const MAY_HOLD = /"provider"\s*:\s*"socio"/;

/**
 * One server-sent event frame (its lines, without the blank line that ends
 * it) with its data downgraded. Its `data:` lines are one value, joined with
 * newlines as a reader joins them; when that value changes it is sent back
 * as one compact `data:` line, the other lines kept in place.
 */
function legacyFrame(frame: string): string {
    if (!MAY_HOLD.test(frame)) {
        return frame;
    }
    const lines = frame.split('\n');
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''));
    let down: unknown;
    try {
        const parsed: unknown = JSON.parse(data.join('\n'));
        down = downgradeAttachmentParts(parsed);
        if (down === parsed) {
            return frame;
        }
    } catch {
        return frame;
    }
    const first = lines.findIndex((line) => line.startsWith('data:'));
    return lines
        .flatMap((line, index) =>
            !line.startsWith('data:') ? [line] : index === first ? [`data: ${JSON.stringify(down)}`] : [],
        )
        .join('\n');
}

/**
 * A server-sent events response as such a client reads it: each frame's
 * attachment parts as the pre-1.0 reference, frames passed on as they come.
 * Any other response is returned as it is.
 */
export function legacyMediaStream(response: Response): Response {
    if (!response.body || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        return response;
    }
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = '';
    // SSE lines end in \r\n, \n or \r: read as \n, keeping a trailing \r
    // back, as its \n may come in the next chunk.
    const lines = (text: string, final: boolean) => {
        const held = !final && text.endsWith('\r');
        const normal = (held ? text.slice(0, -1) : text).replace(/\r\n?/g, '\n');
        return { normal, held: held ? '\r' : '' };
    };
    let carry = '';
    const frames = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            const { normal, held } = lines(carry + decoder.decode(chunk, { stream: true }), false);
            carry = held;
            pending += normal;
            let end = pending.indexOf('\n\n');
            while (end !== -1) {
                controller.enqueue(encoder.encode(`${legacyFrame(pending.slice(0, end))}\n\n`));
                pending = pending.slice(end + 2);
                end = pending.indexOf('\n\n');
            }
        },
        flush(controller) {
            pending += lines(carry + decoder.decode(), true).normal;
            if (pending) {
                controller.enqueue(encoder.encode(legacyFrame(pending)));
            }
        },
    });
    return new Response(response.body.pipeThrough(frames), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}
