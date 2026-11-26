import { createHash } from 'node:crypto';

import { Hono, type Context, type Handler, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { DataError } from '@socio/foundation/dataspace/data-error';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { EMBED_MEDIA_ID } from '@socio/shared/embed-card';
import { MEDIA_LIMITS, UPLOAD_HEADER } from '@socio/shared/media-types';

import { servedAs } from './classify.js';
import { MediaError } from './contract.js';
import type { MediaService } from './service.js';
import { mediaViews } from './view.js';

const MB = 1048576;

const pathBody = z.object({ path: z.string().min(1).max(512) }).strict();
const folderMove = z.object({ from: z.string().min(1).max(512), to: z.string().min(1).max(512) }).strict();
const listQuery = z.object({
    folder: z.string().max(512).optional(),
    q: z.string().max(200).optional(),
    kind: z.enum(['image', 'text', 'pdf', 'file']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z
        .string()
        .regex(/^\d{1,9}$/)
        .optional(),
});

/** `Content-Disposition` with the original name, safely encoded. */
function disposition(inline: boolean, name: string) {
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Whether an If-None-Match header names `etag` (weakly compared, as RFC 9110 asks for it). */
function matches(header: string | undefined, etag: string) {
    if (header === undefined) {
        return false;
    }
    const tags = header.split(',').map((tag) => tag.trim().replace(/^W\//, ''));
    return tags.includes('*') || tags.includes(etag);
}

/**
 * `/api/media` (CB-54 step 2): uploads into the user's data space and the
 * chat attachments' metadata and bytes. Signed-in users only: data tokens
 * and service keys never reach these routes.
 */
export function mediaRoutes(media: MediaService) {
    const app = new Hono<AppEnv>();
    const views = mediaViews(media);
    const signedIn: MiddlewareHandler<AppEnv> = async (c, next) => {
        if (c.get('serviceKey') || c.get('dataToken')) {
            return c.json({ error: 'Sign in to the app to use files.' }, 403);
        }
        await next();
    };
    app.use('/media', signedIn);
    app.use('/media/*', signedIn);
    const handle =
        (work: (c: Context<AppEnv>) => unknown): Handler<AppEnv> =>
        async (c) => {
            try {
                const result = await work(c);
                if (result instanceof Response) {
                    return result;
                }
                return c.json(result ?? { ok: true });
            } catch (error) {
                if (error instanceof MediaError || error instanceof DataError) {
                    return c.json({ error: error.message }, error.status);
                }
                throw error;
            }
        };
    const missing = (c: Context<AppEnv>) => c.json({ error: 'Attachment not found.' }, 404);
    const body = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>) => {
        const parsed = schema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            throw new MediaError('Invalid request.');
        }
        return parsed.data;
    };
    /**
     * Stored bytes, served so a browser never runs them (see servedAs), with
     * their SHA-256 as the ETag: a file can be replaced under its id, so a
     * copy (a browser's, the native app's `files/`) revalidates with
     * If-None-Match and gets a 304 while the bytes are the same.
     */
    const serve = (c: Context<AppEnv>, data: Uint8Array, name: string, cache: string) => {
        const etag = `"${createHash('sha256').update(data).digest('base64url')}"`;
        if (matches(c.req.header('if-none-match'), etag)) {
            c.header('ETag', etag);
            c.header('Cache-Control', cache);
            return c.body(null, 304);
        }
        const served = servedAs(data);
        const download = c.req.query('download') === '1';
        // Through c.header: these replace what the API middleware set
        // (no-store, the app's CSP) rather than being overwritten by it.
        c.header('Content-Type', served.contentType);
        c.header('Content-Disposition', disposition(served.inline && !download, name));
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Content-Security-Policy', "default-src 'none'; sandbox");
        c.header('Cache-Control', cache);
        c.header('ETag', etag);
        return c.body(new Uint8Array(data));
    };

    app.get('/media/limits', (c) =>
        c.json({
            fileMaxBytes: media.data.limits.fileMaxBytes,
            perMessage: MEDIA_LIMITS.perMessage,
            imageModelMaxBytes: media.imageModelMaxBytes,
        }),
    );
    app.post(
        '/media/uploads',
        // Read per request: an admin may change the limit in Settings.
        (c, next) =>
            bodyLimit({
                maxSize: media.data.limits.fileMaxBytes,
                onError: (c) =>
                    c.json(
                        {
                            error: `Files can be at most ${Math.round(media.data.limits.fileMaxBytes / MB)} MB.`,
                        },
                        413,
                    ),
            })(c, next),
        handle(async (c) => {
            if (
                c.req.header(UPLOAD_HEADER) !== '1' ||
                !c.req.header('content-type')?.startsWith('application/octet-stream')
            ) {
                throw new MediaError(
                    `Upload the file's bytes as application/octet-stream with ${UPLOAD_HEADER}: 1.`,
                    415,
                );
            }
            const purpose = c.req.query('purpose');
            if (purpose !== 'attachment' && purpose !== 'file') {
                throw new MediaError('Say what the upload is for (purpose).');
            }
            let name: string;
            try {
                name = decodeURIComponent(c.req.header('x-file-name') ?? '');
            } catch {
                throw new MediaError('The file name is not readable.');
            }
            if (!name.trim() || name.length > 1000) {
                throw new MediaError('Name the file (X-File-Name).');
            }
            const bytes = new Uint8Array(await c.req.arrayBuffer());
            const result = await media.upload(c.get('user').id, {
                name,
                declaredType: c.req.header('x-file-type')?.slice(0, 100),
                bytes,
                purpose,
                threadId: c.req.query('threadId') || undefined,
                folder: c.req.query('folder') || undefined,
            });
            return c.json(result, 201);
        }),
    );
    app.get(
        '/media/attachments/:id',
        handle(async (c) => {
            const row = await media.readable(c.get('user').id, c.req.param('id') ?? '');
            return row ? media.view(row) : missing(c);
        }),
    );
    app.get(
        '/media/attachments/:id/content',
        handle(async (c) => {
            const row = await media.readable(c.get('user').id, c.req.param('id') ?? '');
            if (!row) {
                return missing(c);
            }
            const { data } = await media.content(row).catch((error: unknown) => {
                // The file was deleted under it: the bubble shows "Removed".
                if (error instanceof DataError && error.status === 404) {
                    throw new MediaError('Attachment not found.', 404);
                }
                throw error;
            });
            // Revalidated: the file behind an attachment can be replaced or
            // deleted from Media, and the bubble must show that.
            return serve(c, data, row.name, 'private, no-cache');
        }),
    );
    app.delete(
        '/media/attachments/:id',
        handle(async (c) => {
            await media.removePending(c.get('user').id, c.req.param('id') ?? '');
            return { ok: true };
        }),
    );

    // A link card's image (CB-230): a copy `/unfurl` made into its person's
    // Files for a card in a Space page. Whoever may read that Space sees it
    // (CB-181: a private Space's people only); only recorded copies are
    // served, by their own id, never other files.
    app.get(
        '/media/embeds/:id/content',
        handle(async (c) => {
            const id = c.req.param('id') ?? '';
            const found = EMBED_MEDIA_ID.test(id)
                ? await media.embedContent(id, c.get('user').id).catch((error: unknown) => {
                      if (error instanceof DataError && error.status === 404) {
                          return undefined;
                      }
                      throw error;
                  })
                : undefined;
            if (!found) {
                return c.json({ error: 'Media not found.' }, 404);
            }
            return serve(c, found.data, found.file.name, 'private, no-cache');
        }),
    );

    // The Media page (CB-54 step 3): the user's own files, never anyone
    // else's. Folder grants stay on /api/data/grants.
    app.get(
        '/media',
        handle((c) => {
            const query = listQuery.safeParse(c.req.query());
            if (!query.success) {
                throw new MediaError('Invalid request.');
            }
            return views.mediaView(c.get('user').id, query.data);
        }),
    );
    app.get(
        '/media/items/:id',
        handle((c) => media.getItem(c.get('user').id, c.req.param('id') ?? '')),
    );
    app.get(
        '/media/items/:id/content',
        handle(async (c) => {
            const { file, data } = await media.itemContent(c.get('user').id, c.req.param('id') ?? '');
            // A file can be replaced under the same id: revalidate each time.
            return serve(c, data, file.name, 'private, no-cache');
        }),
    );
    app.patch(
        '/media/items/:id',
        handle(async (c) => {
            const { path } = await body(c, pathBody);
            return media.moveItem(c.get('user').id, c.req.param('id') ?? '', path);
        }),
    );
    app.delete(
        '/media/items/:id',
        handle(async (c) => {
            await media.deleteItem(c.get('user').id, c.req.param('id') ?? '');
            return { ok: true };
        }),
    );
    app.post(
        '/media/folders',
        handle(async (c) => {
            const { path } = await body(c, pathBody);
            return c.json(await media.createFolder(c.get('user').id, path), 201);
        }),
    );
    app.patch(
        '/media/folders',
        handle(async (c) => {
            const { from, to } = await body(c, folderMove);
            return media.moveFolder(c.get('user').id, from, to);
        }),
    );
    app.delete(
        '/media/folders',
        handle((c) =>
            media.deleteFolder(c.get('user').id, c.req.query('path') ?? '', c.req.query('recursive') === '1'),
        ),
    );
    return app;
}
