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
const MAY_HOLD = '"provider":"socio"';

/** One server-sent event frame with its `data:` lines' JSON downgraded. */
function legacyFrame(frame: string): string {
    if (!frame.includes(MAY_HOLD)) {
        return frame;
    }
    return frame
        .split('\n')
        .map((line) => {
            if (!line.startsWith('data:')) {
                return line;
            }
            const raw = line.slice(5).trimStart();
            try {
                const parsed: unknown = JSON.parse(raw);
                const down = downgradeAttachmentParts(parsed);
                return down === parsed ? line : `data: ${JSON.stringify(down)}`;
            } catch {
                return line;
            }
        })
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
    const frames = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            pending += decoder.decode(chunk, { stream: true });
            let end = pending.indexOf('\n\n');
            while (end !== -1) {
                controller.enqueue(encoder.encode(`${legacyFrame(pending.slice(0, end))}\n\n`));
                pending = pending.slice(end + 2);
                end = pending.indexOf('\n\n');
            }
        },
        flush(controller) {
            pending += decoder.decode();
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
