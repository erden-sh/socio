import { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { SetupStatus } from '@socio/shared/types';

import type { AuditShape } from '../workspace/contract.js';

import type { ChannelShape, LinksShape } from './contract.js';

/** What the linking routes read: the channel, the links, the audit and the setup status. */
export interface TelegramRoutesPlatform {
    readonly telegram?: Pick<ChannelShape, 'status' | 'username'>;
    readonly workspace: Pick<AuditShape, 'audit'> & {
        readonly telegram: Pick<LinksShape, 'linkFor' | 'createCode' | 'unlink'>;
    };
    setup(userId?: string): Promise<SetupStatus>;
}

/** Account linking for the signed-in user. */
export function telegramRoutes(platform: TelegramRoutesPlatform) {
    const app = new Hono<AppEnv>();
    app.get('/telegram/link', async (c) => {
        const link = await platform.workspace.telegram.linkFor(c.get('user').id);
        return c.json({
            status: (await platform.setup()).telegram,
            bot: platform.telegram?.username ?? null,
            linked: link ? { username: link.username, linkedAt: link.linkedAt } : null,
        });
    });
    // A one-time code, opened as t.me/<bot>?start=<code>.
    app.post('/telegram/link', async (c) => {
        const bot = platform.telegram?.username;
        if (!bot || platform.telegram?.status !== 'online') {
            return c.json({ error: 'Telegram is not connected on this server.' }, 503);
        }
        const { code, expiresAt } = await platform.workspace.telegram.createCode(c.get('user').id);
        return c.json({ url: `https://t.me/${bot}?start=${code}`, expiresAt }, 201);
    });
    // The link is account state and goes; the audit says what it allowed.
    app.delete('/telegram/link', async (c) => {
        const userId = c.get('user').id;
        const link = await platform.workspace.telegram.linkFor(userId);
        const unlinked = await platform.workspace.telegram.unlink(userId);
        if (unlinked && link) {
            platform.workspace.audit({
                actor: userId,
                action: 'unlink',
                targetKind: 'telegram_link',
                targetId: userId,
                detail: `Telegram user ${link.telegramUserId}${link.username ? ` (@${link.username})` : ''}, linked ${new Date(link.linkedAt).toISOString()}`,
            });
        }
        return c.json({ unlinked });
    });
    return app;
}
