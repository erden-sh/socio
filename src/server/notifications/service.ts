import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { nextTurn } from '@socio/data/events';
import { sqliteData } from '@socio/data/open';
import type { UnitOfWork } from '@socio/data/uow';
import type { DataKeyring } from '@socio/foundation/keys/secret-box';
import { dotAvatarPath } from '@socio/shared/mascot';
import {
    channelPreference,
    DEFAULT_NOTIFICATION_LIMITS,
    type NotificationChannelView,
    type NotificationDailyLimits,
} from '@socio/shared/notifications';

import type { MediaShape } from '../media/contract.js';

import { render } from './channel.js';
import type {
    AppDeliveriesShape,
    AppDeliveryStop,
    AppNotice,
    ChannelReport,
    InAppNoticesShape,
    NotificationChannel,
    NotificationChannelsShape,
    NotificationContentInput,
    NotificationImage,
    NotifierShape,
    NotifyInput,
    NotifyResult,
    NotificationsWorkspaceShape,
    PersonNotice,
    Presence,
    PushSettings,
    QueuedAppNotice,
} from './contract.js';
import { AppDeliveryTasks } from './delivery-tasks.js';
import type { NotificationRecord, NotificationRepositories } from './domain/repositories.js';
import { IMAGE_TTL_MS, IN_APP_MS, IN_APP_SHOWN, LIMIT_WINDOW_MS } from './domain/rules.js';
import { resolveImage, type ImageReader } from './images.js';
import { sqliteNotificationRepositories } from './infra/sqlite/index.js';
import { PresenceTracker } from './presence.js';
import { PushChannel } from './push.js';

/** How long notifications, deliveries and in-app notices are kept, in days (the resource policy). */
export type NotificationRetention = () => {
    notificationDays: number;
    deliveryDays: number;
    noticeDays: number;
};

/**
 * Notifications (CB-114): the channels modules register, the person's
 * choices for each (their preferences), whether they're using the brain
 * (presence), the limits, and the record of each notification and where
 * it went.
 */
export class NotificationService
    implements NotifierShape, NotificationChannelsShape, AppDeliveriesShape, InAppNoticesShape
{
    readonly presence = new PresenceTracker();
    readonly push: PushChannel;
    private channels = new Map<string, NotificationChannel>();
    private uow: UnitOfWork;
    private repos: NotificationRepositories;
    private appDeliveries: AppDeliveryTasks;

    constructor(
        db: DatabaseSync,
        private options: {
            workspace: NotificationsWorkspaceShape;
            secret: DataKeyring;
            push: PushSettings;
            /** The app's origin, for links, icons and images. */
            origin?: string;
            log: (line: string) => void;
            fetch?: typeof fetch;
            retention?: NotificationRetention;
            /** `NOTIFY_PER_*_DAILY`: `notify_user`'s limits under an admin's (`NotificationsConfig`). */
            dailyLimits?: NotificationDailyLimits;
            /** The web reader a notification's outside image is downloaded through (images.ts). */
            web: ImageReader;
        },
    ) {
        this.appDeliveries = new AppDeliveryTasks(options.log);
        const data = sqliteData(db);
        this.uow = data.uow;
        this.repos = sqliteNotificationRepositories(data);
        this.push = new PushChannel(this.uow, this.repos, {
            secret: options.secret,
            settings: options.push,
            origin: options.origin,
            log: options.log,
            fetch: options.fetch,
        });
        this.register(this.push);
    }

    get origin() {
        return (this.options.origin ?? 'http://localhost').replace(/\/$/, '');
    }

    /** `notify_user`'s limits from the environment, before an admin's (`notificationLimits`). */
    get dailyLimits() {
        return this.options.dailyLimits;
    }

    /**
     * A notification's image from what a Dot gave (images.ts): the person's
     * own media, else downloaded through the web reader the root gave.
     */
    resolveImage(raw: string, turn: { userId: string; dotId: string; signal?: AbortSignal }, media: MediaShape) {
        return resolveImage(raw, turn, { media, web: this.options.web, origin: this.origin });
    }

    /** Adds a channel; returns its removal (a module's `stop`). */
    register(channel: NotificationChannel) {
        this.channels.set(channel.id, channel);
        return () => {
            if (this.channels.get(channel.id) === channel) {
                this.channels.delete(channel.id);
            }
        };
    }

    /** Account → Notifications: every channel, with the person's choices and targets. */
    async views(userId: string, signal?: AbortSignal): Promise<NotificationChannelView[]> {
        if (signal?.aborted) {
            return [];
        }
        const preferences = this.options.workspace.preferences(userId).notifications;
        const views: NotificationChannelView[] = [];
        for (const channel of [...this.channels.values()]) {
            if (signal?.aborted) {
                break;
            }
            const targets = await channel.targets(userId);
            if (signal?.aborted) {
                break;
            }
            const note = targets.length ? undefined : await channel.note?.(userId);
            if (signal?.aborted) {
                break;
            }
            views.push({
                id: channel.id,
                label: channel.label,
                ...channelPreference(preferences, channel.id),
                targets,
                ...(note ? { note } : {}),
            });
        }
        return views;
    }

    /** The channels that are on and reach the person. */
    private async reaching(userId: string, signal?: AbortSignal) {
        return (await this.views(userId, signal)).filter((view) => view.enabled && view.targets.length > 0);
    }

    /** Whether any channel that's on reaches the person (the capability's status). */
    async reachable(userId: string) {
        return (await this.reaching(userId)).length > 0;
    }

    /** Sent by socios in the last day: by this one for the person, and for the person by all. */
    usage(dotId: string, userId: string, now = Date.now()) {
        return this.repos.notifications.usage(dotId, userId, now - LIMIT_WINDOW_MS);
    }

    /**
     * A Dot's notification: nothing while the person looks at the turn's
     * chat (the Dot says it in its reply), a toast while they're elsewhere
     * in the brain, else every channel they turned on that reaches them.
     */
    async notify(
        input: NotifyInput,
        limits: NotificationDailyLimits = DEFAULT_NOTIFICATION_LIMITS,
    ): Promise<NotifyResult> {
        const path = input.path ?? `/chats/${encodeURIComponent(input.threadId)}`;
        const presence = this.presence.judge(input.userId, input.threadId);
        const views = await this.reaching(input.userId);
        // An image is kept only when a channel will show it.
        const image =
            presence === 'away' && input.image && views.some((view) => view.content === 'message')
                ? this.imageFor(input.image)
                : undefined;
        const id = randomUUID();
        const now = Date.now();
        // The limits' count, the image, the notification and an in-app notice
        // in one unit of work, queued behind one open on the connection, so
        // calls at the same time can't pass the limits together (CB-110).
        const limited = await this.uow.run(
            async () => {
                const used = await this.usage(input.dot.id, input.userId, now);
                if (used.byDot >= limits.perDot || used.byUser >= limits.perUser) {
                    return true;
                }
                if (image) {
                    await this.repos.images.insert({
                        token: image.token,
                        userId: input.userId,
                        mediaType: image.image.mediaType,
                        bytes: image.image.bytes,
                        expiresAt: now + IMAGE_TTL_MS,
                    });
                }
                await this.repos.notifications.insert(
                    id,
                    {
                        userId: input.userId,
                        dotId: input.dot.id,
                        threadId: input.threadId,
                        trigger: input.trigger,
                        causeId: input.causeId,
                        title: input.title ?? '',
                        message: input.message,
                        link: path,
                        imageToken: image?.token ?? null,
                        presence,
                    },
                    now,
                );
                if (presence === 'in_app') {
                    await this.showInApp(input.userId, id, now, {
                        title: input.title ? `${input.dot.name}: ${input.title}` : input.dot.name,
                        body: input.message,
                        link: path,
                    });
                }
                return false;
            },
            { label: 'notify' },
        );
        if (limited) {
            return {
                outcome: 'rate_limited',
                message: `Today's notifications are used up (${limits.perDot} a day from you for this person, ${limits.perUser} for them from all socios). Say it in the chat or the run's result instead.`,
            };
        }
        if (presence === 'present') {
            return {
                outcome: 'present',
                message: 'They are looking at this chat right now, so nothing was sent: say it in your reply.',
            };
        }
        if (presence === 'in_app') {
            return {
                outcome: 'shown_in_app',
                message: 'They are using Socio right now, so it was shown there instead of sent to their devices.',
            };
        }
        const channels = await this.deliver(
            id,
            input.userId,
            views.map((view) => view.id),
            {
                from: input.dot.name,
                title: input.title,
                message: input.message,
                path,
                // Its character now (CB-256), not the one the turn started with.
                icon: dotAvatarPath(this.options.workspace.dot(input.dot.id) ?? input.dot),
                image: image?.image,
                tag: input.threadId,
            },
        );
        const sent = channels.reduce((sum, report) => sum + report.sent, 0);
        if (!sent) {
            return {
                outcome: 'unreachable',
                channels,
                message: channels.length
                    ? 'It could not be delivered to any of their channels. Say it in the chat or the run’s result instead.'
                    : 'They have no notification channel turned on (Account → Notifications), so nothing was sent. Say it in the chat or the run’s result, and mention they can turn notifications on.',
            };
        }
        return {
            outcome: 'sent',
            channels,
            message: `Sent to ${channels
                .filter((report) => report.sent)
                .map((report) => report.channel)
                .join(' and ')}.`,
        };
    }

    /**
     * A notice from Socio itself, without a Dot (a failed restore
     * drill, CB-111): shown in the app while the person uses it, else sent to
     * every channel they turned on. Dots' daily limits don't count it.
     */
    async notifyFromApp(input: AppNotice) {
        const { userId, title, message, path } = input;
        const presence = this.presence.judge(userId);
        const id = randomUUID();
        const now = Date.now();
        // The notification and its in-app notice together (CB-110).
        await this.uow.run(
            async () => {
                await this.record(id, now, {
                    userId,
                    dotId: null,
                    threadId: null,
                    trigger: input.trigger,
                    causeId: null,
                    title,
                    message,
                    link: path,
                    imageToken: null,
                    presence,
                });
                if (presence !== 'away') {
                    await this.showInApp(userId, id, now, {
                        title,
                        body: message,
                        link: path,
                    });
                }
            },
            { label: 'notify from the app' },
        );
        if (presence !== 'away') {
            return [];
        }
        const views = await this.reaching(userId);
        return this.deliver(
            id,
            userId,
            views.map((view) => view.id),
            {
                from: 'Socio',
                title,
                message,
                path,
                icon: '/icons/icon-192.png',
            },
        );
    }

    /**
     * A notice about a room for one of its members (CB-216): a mention, a
     * turn of theirs that finished, a report, an invitation. Nothing while
     * they look at the room (`threadId`) itself, a toast while they're
     * elsewhere in Socio, else every channel they turned on, with what each
     * shows by their choice. Socios' daily limits don't count it: the
     * caller sends each cause once (`room_notices`).
     */
    async notifyPerson(input: PersonNotice): Promise<{ presence: Presence; channels: ChannelReport[] }> {
        const presence = this.presence.judge(input.userId, input.threadId);
        const id = randomUUID();
        const now = Date.now();
        await this.uow.run(
            async () => {
                await this.record(id, now, {
                    userId: input.userId,
                    dotId: input.dotId ?? null,
                    threadId: input.threadId ?? null,
                    trigger: input.trigger,
                    causeId: input.causeId,
                    title: input.title,
                    message: input.message,
                    link: input.path,
                    imageToken: null,
                    presence,
                });
                if (presence === 'in_app') {
                    await this.showInApp(input.userId, id, now, {
                        title: `${input.from}: ${input.title}`,
                        body: input.message,
                        link: input.path,
                    });
                }
            },
            { label: 'notify about a room' },
        );
        if (presence !== 'away') {
            return { presence, channels: [] };
        }
        const views = await this.reaching(input.userId);
        const channels = await this.deliver(
            id,
            input.userId,
            views.map((view) => view.id),
            {
                from: input.from,
                title: input.title,
                message: input.message,
                path: input.path,
                icon: input.icon ?? '/icons/icon-192.png',
                ...(input.threadId ? { tag: input.threadId } : {}),
            },
        );
        return { presence, channels };
    }

    /** A trusted durable outbox's notice. Caller claims its stable id in this same unit. */
    async queueFromApp(input: QueuedAppNotice) {
        const presence = this.presence.judge(input.userId);
        const now = Date.now();
        await this.uow.run(
            async () => {
                await this.record(input.id, now, {
                    userId: input.userId,
                    dotId: null,
                    threadId: null,
                    trigger: input.trigger,
                    causeId: null,
                    title: input.title,
                    message: input.message,
                    link: input.path,
                    imageToken: null,
                    presence,
                });
                // Keep an in-app fallback even if the one external delivery attempt is interrupted.
                await this.showInApp(input.userId, input.id, now, {
                    title: input.title,
                    body: input.message,
                    link: input.path,
                });
                this.uow.afterCommit(() => {
                    if (presence !== 'away') {
                        return;
                    }
                    this.appDeliveries.enqueue(input.id, async (signal) => {
                        await nextTurn();
                        if (signal.aborted || this.options.workspace.isDeactivated(input.userId)) {
                            return;
                        }
                        const views = await this.reaching(input.userId, signal);
                        if (signal.aborted) {
                            return;
                        }
                        await this.deliver(
                            input.id,
                            input.userId,
                            views.map((view) => view.id),
                            {
                                from: 'Socio',
                                title: input.title,
                                message: input.message,
                                path: input.path,
                                icon: '/icons/icon-192.png',
                            },
                            signal,
                        );
                    });
                });
            },
            { label: 'queue app outbox notification' },
        );
    }

    appDeliveryStatus() {
        return this.appDeliveries.status();
    }
    resumeAppDeliveries() {
        this.appDeliveries.resume();
    }
    waitForAppDeliveries(timeoutMs?: number, signal?: AbortSignal) {
        return this.appDeliveries.idle(timeoutMs, signal);
    }
    stopAppDeliveries(timeoutMs?: number, signal?: AbortSignal): Promise<AppDeliveryStop> {
        return this.appDeliveries.stop(timeoutMs, signal);
    }

    /** A person's test from Account → Notifications: every channel that's on, now. */
    async test(userId: string) {
        const views = await this.reaching(userId);
        const id = randomUUID();
        await this.record(id, Date.now(), {
            userId,
            dotId: null,
            threadId: null,
            trigger: 'test',
            causeId: null,
            title: 'Test notification',
            message: 'This is a test from Socio.',
            link: '/settings/notifications',
            imageToken: null,
            presence: 'away',
        });
        return this.deliver(
            id,
            userId,
            views.map((view) => view.id),
            {
                from: 'Socio',
                title: 'Test notification',
                message: 'This is a test from Socio.',
                path: '/settings/notifications',
                icon: '/icons/icon-192.png',
            },
        );
    }

    private async deliver(
        notificationId: string,
        userId: string,
        channelIds: readonly string[],
        content: NotificationContentInput,
        signal?: AbortSignal,
    ) {
        const reports: ChannelReport[] = [];
        for (const channelId of channelIds) {
            if (signal?.aborted) {
                return reports;
            }
            const channel = this.channels.get(channelId);
            if (!channel) {
                continue;
            }
            const report = { channel: channelId, sent: 0, failed: 0 };
            const targets = await channel.targets(userId);
            if (signal?.aborted) {
                return reports;
            }
            for (const target of targets) {
                if (signal?.aborted) {
                    return reports;
                }
                if (signal && this.options.workspace.isDeactivated(userId)) {
                    return reports;
                }
                const preference = channelPreference(
                    this.options.workspace.preferences(userId).notifications,
                    channelId,
                );
                if (!preference.enabled) {
                    continue;
                }
                const rendered = render(content, preference.content, this.origin);
                let result;
                try {
                    result = await (signal
                        ? channel.send(userId, target, rendered, signal)
                        : channel.send(userId, target, rendered));
                } catch (error) {
                    result = {
                        outcome: 'failed' as const,
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
                if (signal?.aborted) {
                    return reports;
                } // A late transport result must not write after shutdown.
                // Queued behind another chain's unit of work, and over before the
                // next target's send (CB-110).
                await this.repos.notifications.addDelivery({
                    notificationId,
                    channel: channelId,
                    target: target.id,
                    outcome: result.outcome,
                    error: result.outcome === 'failed' ? result.error : null,
                    at: Date.now(),
                });
                if (result.outcome === 'sent') {
                    report.sent++;
                } else {
                    report.failed++;
                }
            }
            reports.push(report);
        }
        return reports;
    }

    private record(id: string, now: number, record: NotificationRecord) {
        return this.repos.notifications.insert(id, record, now);
    }

    private showInApp(
        userId: string,
        notificationId: string,
        now: number,
        notice: { title: string; body: string; link: string },
    ) {
        return this.repos.inApp.insert({
            id: randomUUID(),
            userId,
            notificationId,
            ...notice,
            createdAt: now,
        });
    }

    /** An image's random token (32 bytes) and its address in the brain. */
    private imageFor(image: Omit<NotificationImage, 'url'>) {
        const token = randomBytes(32).toString('base64url');
        return {
            token,
            image: {
                ...image,
                url: `${this.origin}/notification-images/${token}`,
            },
        };
    }

    // --- In the app, images, pruning -------------------------------------

    /** The person's unseen notices of the last day, oldest first (`/api/state`). */
    inApp(userId: string, now = Date.now()) {
        return this.repos.inApp.unseen(userId, now - IN_APP_MS, IN_APP_SHOWN);
    }
    seenInApp(userId: string, ids: readonly string[], now = Date.now()) {
        return this.repos.inApp.markSeen(userId, ids, now);
    }

    /** A kept image while its token works (7 days). */
    async image(token: string, now = Date.now()) {
        const row = await this.repos.images.live(token, now);
        return row && { mediaType: row.mediaType, bytes: Buffer.from(row.bytes) };
    }

    /** Expired images, old notifications, their deliveries and notices. */
    prune(now = Date.now()) {
        const policy = this.options.retention?.() ?? {
            notificationDays: 0,
            deliveryDays: 400,
            noticeDays: 0,
        };
        const before = (days: number) => now - days * 86_400_000;
        return this.uow.run(
            async () => {
                await this.repos.images.removeExpired(now);
                if (policy.notificationDays > 0) {
                    await this.repos.notifications.removeRecordsBefore(before(policy.notificationDays));
                }
                if (policy.deliveryDays > 0) {
                    await this.repos.notifications.removeDeliveriesBefore(before(policy.deliveryDays));
                }
                if (policy.noticeDays > 0) {
                    await this.repos.inApp.removeBefore(before(policy.noticeDays));
                }
            },
            { label: 'prune notifications' },
        );
    }
}
