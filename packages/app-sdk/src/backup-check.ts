import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

import {
    ENVELOPE_TTL_MS,
    envelopeKeyFrom,
    newJti,
    requestTargetHash,
    signEnvelope,
    type EnvelopeClaims,
} from './envelope.js';
import {
    checkSnapshotManifest,
    itemChunks,
    itemChunkSize,
    PLUGIN_SNAPSHOT_ID,
    type PluginSnapshotManifest,
} from './snapshot.js';

/**
 * The backup conformance kit, `@socio/app-sdk/backup-check` (CB-458): what a
 * stateful plugin's CI runs to show it speaks the snapshot protocol the
 * way the workspace will call it. It drives the plugin's fetch handler, or
 * any plugin URL (a plugin in any language), with host envelopes signed
 * by the real codec, and checks:
 *
 * - The SDK's routes refuse no envelope, a person's, another plugin's,
 *   another key's and a replayed one; a host envelope opens nothing off
 *   `/__cb/`.
 * - `begin` refuses a bad id or reason, and a quiesced begin with no hold.
 * - A snapshot becomes `ready`, its manifest passes the host's own check
 *   (paths, volumes, sizes, chunk lists, no SQLite companions), every item
 *   and chunk is the bytes its hashes name, and `DELETE` drops it.
 * - Quiesce holds a writing route (503 with `Retry-After`) through the
 *   snapshot's `DELETE`, until the hold's own `DELETE`.
 * - `verify` answers ok with a schema version the manifest allows.
 * - With `restore`: an instance in restore mode refuses items before the
 *   manifest, a second different manifest, a wrong item and an early
 *   commit, then takes every item and commits.
 *
 * Self-contained so a plugin can vendor it: it imports `./envelope.js`
 * and `./snapshot.js` only. Test-runner agnostic: `checkBackup` returns
 * named results; `assertBackup` throws with a readable summary.
 */

export type FetchHandler = (request: Request) => Response | Promise<Response>;

/** A plugin in restore mode for `snapshotId` (`CB_RESTORE_SNAPSHOT`), started by the caller. */
export interface RestoreTarget {
    app: FetchHandler | string;
    /** True once the restore committed (the task exited 0, or its marker is on the volume). */
    committed?: () => boolean | Promise<boolean>;
    stop?: () => unknown;
}

export interface BackupCheckOptions {
    /** The plugin's id, without `plugin:`. */
    pluginId: string;
    /** The plugin's actor key (base64url), as its test environment's `CB_ACTOR_KEY`. */
    key: string;
    /** The plugin's fetch handler, or its loopback URL. */
    app: FetchHandler | string;
    /** The manifest's non-ephemeral volumes. */
    volumes: readonly string[];
    /** The manifest's `backup.schema`. */
    schema: number;
    /** A writing route, to check that quiesce holds it; sent with the owner's envelope. */
    write?: { method: string; path: string; body?: string; headers?: Record<string, string> };
    /** Starts an instance in restore mode for a snapshot id, to check the restore side. */
    restore?: (snapshotId: string) => RestoreTarget | Promise<RestoreTarget>;
    /** How long a snapshot may take to be ready; 60 s. */
    timeoutMs?: number;
    now?: () => number;
}

export interface BackupCheckResult {
    name: string;
    ok: boolean;
    detail?: string;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A fresh snapshot id, as the host picks them: a ULID. */
export function newSnapshotId(now = Date.now()) {
    let time = '';
    let value = now;
    for (let i = 0; i < 10; i += 1) {
        time = CROCKFORD[value % 32] + time;
        value = Math.floor(value / 32);
    }
    const random = [...randomBytes(16)].map((byte) => CROCKFORD[byte % 32]).join('');
    return time + random;
}

interface Answer {
    status: number;
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
}

type Body = string | Uint8Array | ReadableStream<Uint8Array>;

async function send(
    app: FetchHandler | string,
    method: string,
    target: string,
    init: { envelope?: string; body?: Body; headers?: Record<string, string> } = {},
): Promise<Answer> {
    const headers = new Headers(init.headers);
    if (init.envelope) {
        headers.set('x-cb-actor', init.envelope);
    }
    if (typeof init.body === 'string' && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
    }
    const request = {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body as BodyInit, duplex: 'half' }),
    } as RequestInit;
    if (typeof app === 'string') {
        return sendRaw(app, method, target, headers, init.body);
    }
    const response = await app(new Request(`http://plugin.invalid${target}`, request));
    return { status: response.status, headers: response.headers, body: response.body };
}

/**
 * One request to a plugin URL over its own connection, with the
 * request-target as written. Not `fetch`: it retries a request whose
 * kept-alive socket was closed, which replays its envelope.
 */
function sendRaw(origin: string, method: string, target: string, headers: Headers, body?: Body): Promise<Answer> {
    const url = new URL(origin);
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const flat: Record<string, string> = {};
    headers.forEach((value, name) => {
        flat[name] = value;
    });
    return new Promise<Answer>((resolve, reject) => {
        const request = send(
            {
                host: url.hostname,
                port: url.port,
                method,
                path: `${url.pathname.replace(/\/$/, '')}${target}`,
                headers: flat,
                agent: false,
            },
            (response) => {
                const answerHeaders = new Headers();
                for (const [name, value] of Object.entries(response.headers)) {
                    if (typeof value === 'string') {
                        answerHeaders.set(name, value);
                    } else if (Array.isArray(value)) {
                        for (const each of value) {
                            answerHeaders.append(name, each);
                        }
                    }
                }
                resolve({
                    status: response.statusCode ?? 0,
                    headers: answerHeaders,
                    body: Readable.toWeb(response) as ReadableStream<Uint8Array>,
                });
            },
        );
        request.on('error', reject);
        if (body === undefined) {
            request.end();
        } else if (typeof body === 'string' || body instanceof Uint8Array) {
            request.end(body);
        } else {
            Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>)
                .on('error', (error) => request.destroy(error))
                .pipe(request);
        }
    });
}

const drain = async (answer: Answer) => {
    await answer.body?.cancel().catch(() => undefined);
};

const bytesOf = async (answer: Answer) => Buffer.from(await new Response(answer.body).arrayBuffer());

const jsonOf = async (answer: Answer): Promise<Record<string, unknown>> => {
    try {
        const value = JSON.parse((await bytesOf(answer)).toString('utf8')) as unknown;
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
        return {};
    }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs every check and returns each result. */
export async function checkBackup(options: BackupCheckOptions): Promise<BackupCheckResult[]> {
    const results: BackupCheckResult[] = [];
    const now = options.now ?? Date.now;
    const key = envelopeKeyFrom(options.key);
    if (!key) {
        return [{ name: 'the actor key is usable', ok: false, detail: 'key is not a base64url key' }];
    }
    const otherKey = new Uint8Array(randomBytes(32));
    const aud = `plugin:${options.pluginId}`;
    const timeout = options.timeoutMs ?? 60_000;
    const rules = { volumes: options.volumes, schema: options.schema, maxBytes: Number.MAX_SAFE_INTEGER };

    const record = (name: string, ok: boolean, detail?: string) => {
        results.push({ name, ok, ...(ok || detail === undefined ? {} : { detail }) });
        return ok;
    };
    const expectStatus = async (name: string, answer: Answer, ...wanted: number[]) => {
        await drain(answer);
        return record(name, wanted.includes(answer.status), `got ${answer.status}, wanted ${wanted.join(' or ')}`);
    };

    // One clock reading per envelope: two could make `exp - iat` a millisecond over the TTL, which the SDK refuses.
    const hostEnvelope = (method: string, target: string, over: { aud?: string; key?: Uint8Array } = {}) => {
        const at = now();
        return signEnvelope(over.key ?? key, {
            aud: over.aud ?? aud,
            sub: 'host',
            acc: 'host',
            req: { m: method, p: requestTargetHash(target) },
            iat: at,
            exp: at + ENVELOPE_TTL_MS,
            jti: newJti(),
        });
    };
    const ownerEnvelope = (method: string, target: string) => {
        const at = now();
        const claims: EnvelopeClaims = {
            aud,
            sub: 'ada-0000000000000001',
            acc: 'owner',
            sid: 'session-000000000001',
            req: { m: method, p: requestTargetHash(target) },
            iat: at,
            exp: at + ENVELOPE_TTL_MS,
            jti: newJti(),
            ver: null,
        };
        return signEnvelope(key, claims);
    };
    const host = (
        app: FetchHandler | string,
        method: string,
        target: string,
        body?: Body,
        headers?: Record<string, string>,
    ) =>
        send(app, method, target, {
            envelope: hostEnvelope(method, target),
            ...(body === undefined ? {} : { body }),
            ...(headers ? { headers } : {}),
        });
    const app = options.app;
    const write = options.write;
    const sendWrite = () =>
        write
            ? send(app, write.method, write.path, {
                  envelope: ownerEnvelope(write.method, write.path),
                  ...(write.body === undefined ? {} : { body: write.body }),
                  ...(write.headers ? { headers: write.headers } : {}),
              })
            : undefined;

    const begin = (snapshotId: string, quiesce: boolean, reason = 'manual') =>
        host(app, 'POST', '/__cb/backup', JSON.stringify({ snapshotId, reason, quiesce }));

    /** Begins a snapshot and polls it until it leaves `preparing`; its manifest when ready. */
    const takeSnapshot = async (snapshotId: string, quiesce: boolean, label: string) => {
        const started = await begin(snapshotId, quiesce);
        const answer = await jsonOf(started);
        if (
            !record(
                `${label}: begin answers 202 with its id`,
                started.status === 202 && answer.snapshotId === snapshotId,
                `got ${started.status}`,
            )
        ) {
            return undefined;
        }
        const deadline = Date.now() + timeout;
        let wait = 50;
        for (;;) {
            const polled = await host(app, 'GET', `/__cb/backup/${snapshotId}`);
            const state = await jsonOf(polled);
            if (polled.status !== 200) {
                record(`${label}: becomes ready`, false, `polling answered ${polled.status}`);
                return undefined;
            }
            if (state.state === 'ready') {
                record(`${label}: becomes ready`, true);
                try {
                    const manifest = checkSnapshotManifest(state.manifest, rules);
                    record(`${label}: its manifest passes the workspace's check`, true);
                    return manifest;
                } catch (error) {
                    record(`${label}: its manifest passes the workspace's check`, false, (error as Error).message);
                    return undefined;
                }
            }
            if (state.state !== 'preparing') {
                record(`${label}: becomes ready`, false, `state ${String(state.state)}: ${String(state.error ?? '')}`);
                return undefined;
            }
            if (Date.now() > deadline) {
                record(`${label}: becomes ready`, false, `still preparing after ${timeout} ms`);
                return undefined;
            }
            await sleep(wait);
            wait = Math.min(wait * 2, 1000);
        }
    };

    const itemTarget = (snapshotId: string, index: number, chunk?: number) =>
        `/__cb/backup/${snapshotId}/items/${index}${chunk === undefined ? '' : `?chunk=${chunk}`}`;

    // ---- who may call ----------------------------------------------------------
    const beginBody = () => JSON.stringify({ snapshotId: newSnapshotId(now()), reason: 'manual', quiesce: false });
    await expectStatus(
        'no envelope on /__cb/backup: 401',
        await send(app, 'POST', '/__cb/backup', { body: beginBody() }),
        401,
    );
    await expectStatus(
        "a person's envelope on /__cb/backup: 401",
        await send(app, 'POST', '/__cb/backup', { envelope: ownerEnvelope('POST', '/__cb/backup'), body: beginBody() }),
        401,
    );
    await expectStatus(
        "another plugin's host envelope: 401",
        await send(app, 'POST', '/__cb/backup', {
            envelope: hostEnvelope('POST', '/__cb/backup', { aud: `${aud}-other` }),
            body: beginBody(),
        }),
        401,
    );
    await expectStatus(
        'a host envelope under another key: 401',
        await send(app, 'POST', '/__cb/backup', {
            envelope: hostEnvelope('POST', '/__cb/backup', { key: otherKey }),
            body: beginBody(),
        }),
        401,
    );
    {
        const target = `/__cb/backup/${newSnapshotId(now())}`;
        const envelope = hostEnvelope('GET', target);
        const first = await send(app, 'GET', target, { envelope });
        await expectStatus('an unknown snapshot: 404', first, 404);
        await expectStatus('a replayed host envelope: 401', await send(app, 'GET', target, { envelope }), 401);
    }
    await expectStatus(
        'a host envelope off /__cb/ opens nothing (401, 403 or 404)',
        await send(app, 'GET', '/socio-backup-check', { envelope: hostEnvelope('GET', '/socio-backup-check') }),
        401,
        403,
        404,
    );

    // ---- begin's input ---------------------------------------------------------
    await expectStatus(
        'begin with a snapshot id that is not a ULID: 400',
        await host(
            app,
            'POST',
            '/__cb/backup',
            JSON.stringify({ snapshotId: 'acme-1', reason: 'manual', quiesce: false }),
        ),
        400,
    );
    await expectStatus(
        'begin with an unknown reason: 400',
        await host(
            app,
            'POST',
            '/__cb/backup',
            JSON.stringify({ snapshotId: newSnapshotId(now()), reason: 'whim', quiesce: false }),
        ),
        400,
    );
    await expectStatus('a quiesced begin without a hold: 409', await begin(newSnapshotId(now()), true), 409);

    // ---- a snapshot --------------------------------------------------------------
    const snapshotId = newSnapshotId(now());
    const manifest = await takeSnapshot(snapshotId, false, 'a snapshot');
    if (manifest) {
        let bytesOk = true;
        let detail = '';
        for (const [index, item] of manifest.items.entries()) {
            const chunks = itemChunks(item);
            for (const [n, hash] of chunks.entries()) {
                const answer = await host(app, 'GET', itemTarget(snapshotId, index, item.chunks ? n : undefined));
                const body = answer.status === 200 ? await bytesOf(answer) : (await drain(answer), Buffer.alloc(0));
                const size = itemChunkSize(item, n);
                if (
                    answer.status !== 200 ||
                    body.length !== size ||
                    createHash('sha256').update(body).digest('hex') !== hash
                ) {
                    bytesOk = false;
                    detail = `item ${index} chunk ${n}: status ${answer.status}, ${body.length} of ${size} bytes`;
                }
            }
            if (item.chunks) {
                const whole = await host(app, 'GET', itemTarget(snapshotId, index));
                const body = whole.status === 200 ? await bytesOf(whole) : (await drain(whole), Buffer.alloc(0));
                if (createHash('sha256').update(body).digest('hex') !== item.sha256) {
                    bytesOk = false;
                    detail = `item ${index} whole: status ${whole.status}, not the bytes its sha256 names`;
                }
            }
        }
        record('every item and chunk is the bytes its hashes name', bytesOk, detail);
        await expectStatus(
            'an item index past the manifest: 404',
            await host(app, 'GET', itemTarget(snapshotId, manifest.items.length)),
            404,
        );
        await expectStatus(
            'DELETE ends the snapshot',
            await host(app, 'DELETE', `/__cb/backup/${snapshotId}`),
            200,
            204,
        );
        await expectStatus('an ended snapshot is gone: 404', await host(app, 'GET', `/__cb/backup/${snapshotId}`), 404);
    }

    // ---- quiesce ---------------------------------------------------------------
    {
        const held = newSnapshotId(now());
        const hold = await host(app, 'POST', '/__cb/backup/quiesce', JSON.stringify({ snapshotId: held }));
        if (await expectStatus('quiesce holds writes: 200', hold, 200)) {
            const refused = await sendWrite();
            if (refused) {
                await drain(refused);
                record(
                    'a write while held: 503 with Retry-After',
                    refused.status === 503 && !!refused.headers.get('retry-after'),
                    `got ${refused.status}`,
                );
            }
            const quiesced = await takeSnapshot(held, true, 'a quiesced snapshot');
            if (quiesced) {
                await expectStatus(
                    "the quiesced snapshot's DELETE",
                    await host(app, 'DELETE', `/__cb/backup/${held}`),
                    200,
                    204,
                );
            }
            const still = await sendWrite();
            if (still) {
                await drain(still);
                record("writes stay held after the snapshot's DELETE", still.status === 503, `got ${still.status}`);
            }
            await expectStatus(
                "the hold's own DELETE ends it",
                await host(app, 'DELETE', `/__cb/backup/quiesce/${held}`),
                200,
                204,
            );
            const after = await sendWrite();
            if (after) {
                await drain(after);
                record('writes resume after the hold ends', after.status !== 503, `got ${after.status}`);
            }
        }
    }

    // ---- verify ------------------------------------------------------------------
    {
        const answer = await host(app, 'POST', '/__cb/backup/verify', '{}');
        const body = await jsonOf(answer);
        record(
            'verify answers ok with an allowed schema version',
            answer.status === 200 &&
                body.ok === true &&
                Number.isSafeInteger(body.schemaVersion) &&
                (body.schemaVersion as number) >= 0 &&
                (body.schemaVersion as number) <= options.schema,
            `got ${answer.status} ${JSON.stringify(body).slice(0, 200)}`,
        );
    }

    // ---- restore -----------------------------------------------------------------
    if (options.restore) {
        const sourceId = newSnapshotId(now());
        const source = await takeSnapshot(sourceId, false, 'the snapshot to restore');
        if (source) {
            const target = await options.restore(sourceId);
            try {
                await checkRestore(source, sourceId, target);
            } finally {
                await target.stop?.();
                await drain(await host(app, 'DELETE', `/__cb/backup/${sourceId}`));
            }
        }
    }

    async function checkRestore(source: PluginSnapshotManifest, id: string, target: RestoreTarget) {
        const to = target.app;
        const base = `/__cb/restore/${id}`;
        const manifestBody = JSON.stringify(source);
        await expectStatus(
            "a person's envelope on /__cb/restore: 401",
            await send(to, 'POST', base, { envelope: ownerEnvelope('POST', base), body: manifestBody }),
            401,
        );
        if (source.items.length) {
            await expectStatus(
                'an item before the manifest: 409',
                await host(to, 'PUT', `${base}/items/0`, new Uint8Array(0)),
                409,
            );
        }
        const other = newSnapshotId(now());
        const wrong = await host(to, 'POST', `/__cb/restore/${other}`, manifestBody);
        await drain(wrong);
        record(
            'a manifest for another snapshot is refused',
            wrong.status >= 400 && wrong.status < 500,
            `got ${wrong.status}`,
        );
        if (!(await expectStatus('the manifest is taken', await host(to, 'POST', base, manifestBody), 200))) {
            return;
        }
        await expectStatus(
            'a second, different manifest: 409',
            await host(to, 'POST', base, JSON.stringify({ ...source, createdAt: source.createdAt + 1 })),
            409,
        );
        const first = source.items.findIndex((item) => item.size > 0);
        if (first >= 0) {
            const item = source.items[first];
            const answer = await host(app, 'GET', itemTarget(id, first));
            const body = await bytesOf(answer);
            body[0] ^= 0xff;
            const bad = await host(to, 'PUT', `${base}/items/${first}`, body);
            await drain(bad);
            record(
                'an item that is not the bytes its hash names is refused',
                bad.status >= 400 && bad.status < 500,
                `got ${bad.status} for ${item.size} bytes`,
            );
        }
        if (source.items.length) {
            await expectStatus('a commit with items missing: 409', await host(to, 'POST', `${base}/commit`, '{}'), 409);
        }
        let pushed = true;
        let detail = '';
        for (const index of source.items.keys()) {
            const answer = await host(app, 'GET', itemTarget(id, index));
            if (answer.status !== 200 || !answer.body) {
                await drain(answer);
                pushed = false;
                detail = `item ${index}: the source answered ${answer.status}`;
                continue;
            }
            const put = await host(to, 'PUT', `${base}/items/${index}`, answer.body);
            await drain(put);
            if (put.status !== 200) {
                pushed = false;
                detail = `item ${index}: ${put.status}`;
            }
        }
        record('every item is taken', pushed, detail);
        if (await expectStatus('the restore commits', await host(to, 'POST', `${base}/commit`, '{}'), 200)) {
            if (target.committed) {
                const deadline = Date.now() + 5000;
                let done = await target.committed();
                while (!done && Date.now() < deadline) {
                    await sleep(50);
                    done = await target.committed();
                }
                record('the restore ends (the task exits 0)', done, 'not committed after 5 s');
            }
        }
    }

    return results;
}

/** `checkBackup`, throwing with every failure when one fails. */
export async function assertBackup(options: BackupCheckOptions) {
    const results = await checkBackup(options);
    const failed = results.filter((result) => !result.ok);
    if (failed.length) {
        throw new Error(
            `The plugin does not keep the backup protocol:\n${failed
                .map((result) => `- ${result.name}${result.detail ? `: ${result.detail}` : ''}`)
                .join('\n')}`,
        );
    }
    return results;
}

/** Whether `value` is a snapshot id the host could pick. */
export const isSnapshotId = (value: string) => PLUGIN_SNAPSHOT_ID.test(value);
