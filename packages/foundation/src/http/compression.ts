import type { Context, MiddlewareHandler } from 'hono';
import { compress } from 'hono/compress';

/**
 * Smaller answers go out as they are: gzip's header and trailer are 18
 * bytes, and under 1 kB it saves too little for its CPU time.
 */
export const COMPRESS_MIN_BYTES = 1024;

/**
 * What is compressed: JSON, pages (`text/html`) and their data
 * (`text/x-script`), and other text. Never `text/event-stream`: the
 * compressor holds back small writes, so events would wait.
 */
const COMPRESSIBLE =
    /^\s*(?:application\/(?:json|javascript|xml)|application\/[\w.-]+\+(?:json|xml)|image\/svg\+xml|text\/(?!event-stream\s*(?:;|$))[\w.+-]+)\s*(?:;|$)/i;

/**
 * Never compressed, by path: sign-in (Better Auth's session answers carry
 * the session token, the BREACH case in SECURITY.md) and the chat runtime
 * (CopilotKit's turn streams and their replays are event streams).
 */
const SKIPPED_PATHS = /^\/api\/(?:auth|copilotkit)(?:\/|$)/;

/** Whether this finished response may be compressed. */
export function compressible(response: Response) {
    const headers = response.headers;
    return (
        COMPRESSIBLE.test(headers.get('Content-Type') ?? '') &&
        // A stored file (an attachment, media, a data space file, a download):
        // served as it was stored.
        !headers.has('Content-Disposition') &&
        // Ranges count bytes of what is sent; a compressed body breaks them.
        !headers.has('Accept-Ranges') &&
        !headers.has('Content-Range')
    );
}

/**
 * Reads up to `COMPRESS_MIN_BYTES` of a body whose size isn't known yet
 * (Hono's `c.json` sets no Content-Length). A shorter body gets its
 * Content-Length and goes out as it is; a longer one is put back together,
 * still streaming, for the compressor. It never waits for more than that.
 */
async function measure(c: Context) {
    const body = c.res.body;
    if (!body) {
        return;
    }
    const reader = body.getReader();
    const head: Uint8Array[] = [];
    let size = 0;
    let done = false;
    while (size < COMPRESS_MIN_BYTES) {
        const read = await reader.read();
        if (read.done) {
            done = true;
            break;
        }
        head.push(read.value);
        size += read.value.byteLength;
    }
    if (done) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of head) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        const response = new Response(bytes, c.res);
        response.headers.set('Content-Length', String(size));
        c.res = response;
        return;
    }
    const rest = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of head) {
                controller.enqueue(chunk);
            }
        },
        async pull(controller) {
            const read = await reader.read();
            if (read.done) {
                controller.close();
            } else {
                controller.enqueue(read.value);
            }
        },
        cancel: (reason) => reader.cancel(reason),
    });
    c.res = new Response(rest, c.res);
}

/**
 * gzip for what the app sends (Hono's `compress`, Node's
 * CompressionStream), when the browser asks for it: JSON, pages, their
 * data and text from 1 kB, with `Vary: Accept-Encoding`. Never HEAD, a
 * range request, an event stream, sign-in, the chat runtime, or a stored
 * file. Build files are compressed once, at build time
 * (scripts/precompress.mjs), and served as they are.
 */
export function compression(): MiddlewareHandler {
    return async (c, next) => {
        if (c.req.method === 'HEAD' || c.req.header('Range') !== undefined || SKIPPED_PATHS.test(c.req.path)) {
            return next();
        }
        let eligible = false;
        const gzip = compress({
            encoding: 'gzip',
            threshold: COMPRESS_MIN_BYTES,
            contentTypeFilter: () => eligible,
        });
        await gzip(c, async () => {
            await next();
            eligible = compressible(c.res) && !c.res.headers.has('Content-Encoding');
            if (eligible && !c.res.headers.has('Content-Length')) {
                await measure(c);
            }
        });
    };
}
