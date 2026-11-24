// Notifications' layer offers one service under every tag of its contract,
// reads the people and the socios through workspace's tags, and builds with
// the config and the root's deps it is given; the composition builds
// `NotificationsConfig` from the startup config.
import { Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import type { WebReadRequest, WebResponse } from '@socio/foundation/web/reads';

import { notificationsConfig } from '../src/server/composition/notifications.js';
import { NotificationsWorkspaceLive } from '../src/server/composition/notifications.js';
import {
    AppDeliveries,
    DEFAULT_PUSH_HOSTS,
    InAppNotices,
    NotificationChannels,
    NotificationsConfig,
    Notifier,
    PushKeys,
    UserPresence,
} from '../src/server/notifications/contract.js';
import { NotificationsLive, NotificationsRoot, NotificationsService } from '../src/server/notifications/layer.js';
import { WorkspaceLive } from '../src/server/workspace/layer.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) {
        await step();
    }
    vi.restoreAllMocks();
});

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

function layer(reads: WebReadRequest[] = []) {
    const db = testDatabase();
    const workspace = new WorkspaceStore(db);
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    cleanup.push(() => workspace.close());
    const lines: string[] = [];
    const root = Layer.succeed(
        NotificationsRoot,
        NotificationsRoot.of({
            db,
            secret: { legacy: 'notifications-layer-test-secret-0123456789' },
            retention: () => ({ notificationDays: 30, deliveryDays: 400, noticeDays: 30 }),
            web: {
                read: async (request) => {
                    reads.push(request);
                    const response: WebResponse = {
                        ok: true,
                        status: 200,
                        url: request.url,
                        contentType: 'image/png',
                        headers: {},
                        body: PNG,
                        bytes: PNG.length,
                        complete: true,
                        cached: false,
                        revalidated: false,
                        redirects: 0,
                    };
                    return response;
                },
            },
            log: (line) => lines.push(line),
        }),
    );
    const config = Layer.succeed(
        NotificationsConfig,
        NotificationsConfig.of({
            appOrigin: 'https://brain.example/',
            notificationLimits: { perDot: 3, perUser: 5 },
        }),
    );
    return {
        workspace,
        lines,
        live: NotificationsLive.pipe(
            Layer.provide([root, config, NotificationsWorkspaceLive.pipe(Layer.provide(WorkspaceLive(workspace)))]),
        ),
    };
}

it('offers one service under every tag of the contract', async () => {
    const { live } = layer();
    const seen = await Effect.runPromise(
        Effect.gen(function* () {
            return {
                service: yield* NotificationsService,
                notifier: yield* Notifier,
                channels: yield* NotificationChannels,
                deliveries: yield* AppDeliveries,
                inApp: yield* InAppNotices,
                presence: yield* UserPresence,
                push: yield* PushKeys,
            };
        }).pipe(Effect.provide(live)),
    );
    expect(seen.notifier).toBe(seen.service);
    expect(seen.channels).toBe(seen.service);
    expect(seen.deliveries).toBe(seen.service);
    expect(seen.inApp).toBe(seen.service);
    expect(seen.presence).toBe(seen.service.presence);
    expect(seen.push).toBe(seen.service.push);
});

it('builds the service from NotificationsConfig and reads people through the People tag', async () => {
    const { live } = layer();
    const service = await Effect.runPromise(
        NotificationsService.useSync((service) => service).pipe(Effect.provide(live)),
    );
    expect(service.origin).toBe('https://brain.example');
    expect(service.dailyLimits).toEqual({ perDot: 3, perUser: 5 });
    expect(service.push.settings).toEqual({ hosts: DEFAULT_PUSH_HOSTS });
    // The person's preferences come from the People slice: push is on by default, with no device yet.
    const views = await service.views('alice');
    expect(views.map((view) => view.id)).toEqual(['push']);
    expect(await service.reachable('alice')).toBe(false);
});

it('downloads an outside image through the web reader the root hands in', async () => {
    const reads: WebReadRequest[] = [];
    const { live } = layer(reads);
    const service = await Effect.runPromise(
        NotificationsService.useSync((service) => service).pipe(Effect.provide(live)),
    );
    const media = {} as Parameters<typeof service.resolveImage>[2];
    const image = await service.resolveImage('https://images.example/a.png', { userId: 'alice', dotId: 'd1' }, media);
    expect(image).toEqual({ ok: true, bytes: PNG, mediaType: 'image/png' });
    expect(reads.map((read) => [read.url, read.dotId, read.userId])).toEqual([
        ['https://images.example/a.png', 'd1', 'alice'],
    ]);
});

it('builds NotificationsConfig from the startup configuration', () => {
    const limits = { perDot: 2, perUser: 0 };
    const push = { hosts: ['push.example'], allowHttp: true };
    expect(
        notificationsConfig({
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
            appOrigin: 'https://brain.example',
            push,
            notificationLimits: limits,
        }),
    ).toEqual({ push, appOrigin: 'https://brain.example', notificationLimits: limits });
});
