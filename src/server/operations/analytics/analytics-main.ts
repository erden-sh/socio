import { dirname, join } from 'node:path';

import { serve } from '@hono/node-server';

import { loadSecretFiles } from '@socio/foundation/keys/secret-files';
import { analyticsDefaults, reportingTimeZone } from '@socio/shared/operations/operations-analytics';

import { AnalyticsEngine } from './engine.js';
import { toChild } from './ipc.js';
import { analyticsHttpApp } from './service.js';
import { ETL_STEPS, ETL_VERSION } from './steps.js';

// The analytics process (CB-186): owns the Operations DuckDB file next to
// the database, keeps it up to date from SQLite (read-only), and answers
// the app's queries. `OPS_ANALYTICS_MODE=child`: forked by the app, over
// IPC. `service`: the stack's single-replica `socio-analytics`, over HTTP
// on the internal network with the shared secret.
const mode = process.env.OPS_ANALYTICS_MODE?.trim() || 'service';
const database = process.env.DATABASE_PATH ?? 'data/company-brain.sqlite';
const dir = process.env.OPS_ANALYTICS_DIR?.trim() || join(dirname(database), 'analytics');
const lockRetryMs = Number(process.env.OPS_ANALYTICS_LOCK_RETRY_MS) || 10_000;

const engine = new AnalyticsEngine({
    dir,
    sqlitePath: database,
    defaults: analyticsDefaults(process.env),
    defaultTimeZone: reportingTimeZone(undefined, process.env),
    steps: ETL_STEPS,
    etlVersion: ETL_VERSION,
    lockRetryMs,
    log: (line) => console.log(line),
    onStatus: (status) => {
        if (mode === 'child' && process.connected) {
            process.send?.({ status });
        }
    },
});

let stopping = false;
const shutdown = (close?: (done: () => void) => void) => {
    if (stopping) {
        return;
    }
    stopping = true;
    const exit = setTimeout(() => process.exit(0), 10_000);
    exit.unref();
    void engine.stop().then(() => {
        if (close) {
            close(() => process.exit(0));
        } else {
            process.exit(0);
        }
    });
};

if (mode === 'child') {
    if (!process.send) {
        throw new Error('Child mode needs an IPC channel.');
    }
    process.on('message', (raw) => {
        const message = toChild.safeParse(raw);
        if (!message.success) {
            return;
        }
        if ('shutdown' in message.data) {
            return shutdown();
        }
        const { id, request } = message.data;
        void engine.handle(request).then((answer) => {
            if (process.connected) {
                process.send?.({ id, answer });
            }
        });
    });
    // The app went away without stopping it.
    process.on('disconnect', () => shutdown());
    process.on('SIGTERM', () => shutdown());
    process.on('SIGINT', () => shutdown());
} else if (mode === 'service') {
    loadSecretFiles(process.env, undefined, ['OPS_ANALYTICS_SECRET']);
    const secret = process.env.OPS_ANALYTICS_SECRET?.trim();
    delete process.env.OPS_ANALYTICS_SECRET;
    if (!secret || secret.length < 24) {
        throw new Error('OPS_ANALYTICS_SECRET (or _FILE) must be set, at least 24 characters.');
    }
    const host = process.env.OPS_ANALYTICS_HOST ?? '127.0.0.1';
    const port = Number(process.env.OPS_ANALYTICS_PORT ?? 4340);
    const server = serve({ fetch: analyticsHttpApp(engine, secret).fetch, hostname: host, port }, (info) =>
        console.log(`Analytics listening on ${host}:${info.port}`),
    );
    const close = (done: () => void) => server.close(done);
    process.on('SIGTERM', () => shutdown(close));
    process.on('SIGINT', () => shutdown(close));
} else {
    throw new Error('OPS_ANALYTICS_MODE must be child or service.');
}

void engine.start().catch((error: unknown) => {
    console.error(`Analytics: failed to start: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
});
