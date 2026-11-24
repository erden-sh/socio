import { basename } from 'node:path';

import type { SecretBox } from '@socio/foundation/keys/secret-box';
import {
    autoApplyTarget,
    compareVersions,
    feedId,
    FINISHED_PHASES,
    needsConfirmation,
    newerReleases,
    UPDATE_STALE_MAX_DAYS,
    UPDATE_TAG,
    updateStaleness,
    validCheckHours,
    validRepository,
    validStaleDays,
    type FeedRelease,
    type SavedUpdateSettings,
    type UpdateFeed,
    type UpdateSettings,
    type UpdateStaleness,
    type UpdatesView,
    type UpdaterStatus,
} from '@socio/shared/updates/updates';

import type { BackupsShape } from '../backup/contract.js';
import type { SecretSetting, SecretSettingsShape, WorkspaceSettingsShape } from '../settings/contract.js';

import {
    FEED_TOKEN_SETTING,
    UpdatesError,
    type UpdatesEnvironment,
    type UpdateSettingsInput,
    type UpdatesShape,
} from './contract.js';
import { fetchReleases, UpdateFeedError } from './feed.js';
import { UpdaterClient, UpdaterError } from './updater-client.js';

/** The staleness warning as a notice (CB-323): the same channels as "available". */
export function staleNotice(stale: UpdateStaleness, version: string) {
    const security = stale.security.length
        ? `${stale.security.join(', ')} ${stale.security.length === 1 ? 'is a security release' : 'are security releases'}`
        : '';
    return {
        trigger: 'update_stale',
        title:
            stale.reason === 'security'
                ? `Socio ${stale.security[0]} is a security update`
                : `Socio is ${stale.behindDays} days behind ${stale.newest}`,
        message: `This server runs ${version}${
            stale.reason === 'security'
                ? `, and ${security}`
                : `, released ${stale.behindDays} days before ${stale.newest} (the warning comes after ${stale.staleDays})`
        }. Read the notes and Upgrading steps on the Platform page and update.`,
        path: '/settings/operator',
    };
}

const HOUR = 3_600_000;

/** What the service keeps its settings in: the settings' two slices (the core store). */
export type UpdatesStore = Pick<WorkspaceSettingsShape, 'settings' | 'updateSettings'> & SecretSettingsShape;

export interface UpdateServiceOptions {
    config: UpdatesEnvironment;
    store: UpdatesStore;
    /** Seals the read token (`settings-secrets`, CB-62). */
    box: SecretBox;
    /** The running build (`releaseData()`). */
    running: () => { version: string; commit: string | null };
    /**
     * The running release's date (YYYY-MM-DD) from the build's release
     * notes, when the feed doesn't list it (CB-323).
     */
    runningDate?: () => string | undefined;
    /** The scheduled backups' service; the pre-update backup runs through it. */
    backups: () => BackupsShape | undefined;
    /** Tells every active operator, wherever they are. */
    notifyOperators: (notice: { trigger: string; title: string; message: string; path: string }) => Promise<unknown>;
    log: (line: string) => void;
    /** The feed's transport (tests: a loopback fake behind the URLs). */
    transport?: typeof fetch;
    updaterTransport?: typeof fetch;
    now?: () => number;
}

/**
 * Updates (CB-259): checks the configured feed for releases newer than the
 * running build (on a schedule an operator sets, or when one asks), tells
 * operators once per new release, and hands an update to the updater
 * sidecar after a backup that honors the backup settings (the off-site
 * copy too, when it is configured). It never changes the deployment
 * itself; with no updater configured it only notifies.
 */
export class UpdateService implements UpdatesShape {
    private releases: FeedRelease[] = [];
    private checked?: { at: number; ok: boolean; error?: string };
    private lastAttemptAt?: number;
    private checking?: Promise<void>;
    private preparingState?: UpdatesView['preparing'];
    private preparingRun?: Promise<void>;
    private updater?: UpdaterClient;
    /** An apply between its checks and its background start. */
    private starting = false;
    private lastToken?: { saved: SecretSetting; token?: string };

    constructor(private options: UpdateServiceOptions) {
        if (options.config.updater) {
            this.updater = new UpdaterClient(options.config.updater, options.updaterTransport);
        }
    }

    private now() {
        return this.options.now?.() ?? Date.now();
    }

    private saved(): SavedUpdateSettings {
        return this.options.store.settings().updates ?? {};
    }

    /** The settings in force: an operator's over the environment's. */
    settings(): UpdateSettings & { source: 'settings' | 'environment' } {
        const saved = this.saved();
        const { defaults } = this.options.config;
        const own =
            saved.feed !== undefined ||
            saved.checkHours !== undefined ||
            saved.autoApply !== undefined ||
            saved.staleDays !== undefined;
        return {
            feed: saved.feed !== undefined ? saved.feed : defaults.feed,
            checkHours: saved.checkHours ?? defaults.checkHours,
            autoApply: saved.autoApply ?? defaults.autoApply,
            staleDays: saved.staleDays ?? defaults.staleDays,
            source: own ? 'settings' : 'environment',
        };
    }

    /**
     * The read token for the feed in force: the one an operator saved for
     * exactly that feed, else UPDATES_FEED_TOKEN when the feed is the
     * environment's own. A token never follows a feed it wasn't given for.
     */
    private token(feed: UpdateFeed | null): {
        value?: string;
        source: UpdatesView['token'];
    } {
        if (!feed) {
            return { source: 'none' };
        }
        const saved = this.options.store.secretSetting(FEED_TOKEN_SETTING);
        if (saved && saved.url === feedId(feed)) {
            if (this.lastToken?.saved.value !== saved.value) {
                let token: string | undefined;
                try {
                    const opened = this.options.box.open(saved.value) as {
                        token?: unknown;
                        feed?: unknown;
                    };
                    if (typeof opened?.token === 'string' && opened.feed === feedId(feed)) {
                        token = opened.token;
                    }
                } catch {
                    // Under a data key this server doesn't have.
                }
                this.lastToken = { saved, token };
            }
            return this.lastToken.token
                ? { value: this.lastToken.token, source: 'settings' }
                : { source: 'unreadable' };
        }
        const env = this.options.config.defaults.feed;
        if (this.options.config.token && env && feedId(env) === feedId(feed)) {
            return { value: this.options.config.token, source: 'environment' };
        }
        return { source: 'none' };
    }

    /** Saves an operator's settings; a token goes sealed, for one feed only. */
    async saveSettings(input: UpdateSettingsInput) {
        if (input.checkHours !== undefined && !validCheckHours(input.checkHours)) {
            throw new UpdatesError('invalid', 'Check every 0 to 168 whole hours.');
        }
        if (input.staleDays !== undefined && !validStaleDays(input.staleDays)) {
            throw new UpdatesError(
                'invalid',
                `Warn after 0 (never) to ${UPDATE_STALE_MAX_DAYS.toLocaleString('en-US')} whole days.`,
            );
        }
        if (input.feed && !validRepository(input.feed.kind, input.feed.repository)) {
            throw new UpdatesError(
                'invalid',
                input.feed.kind === 'github' ? 'Give the repository as owner/repo.' : 'Give the image as owner/image.',
            );
        }
        if (
            typeof input.token === 'string' &&
            (!input.token.trim() || input.token.length > 1000 || /\s/.test(input.token.trim()))
        ) {
            throw new UpdatesError('invalid', 'The token must be one word, up to 1,000 characters.');
        }
        const current = this.settings();
        const saved = this.saved();
        const next: SavedUpdateSettings = {
            ...saved,
            ...(input.feed !== undefined ? { feed: input.feed } : {}),
            ...(input.checkHours !== undefined ? { checkHours: input.checkHours } : {}),
            ...(input.autoApply !== undefined ? { autoApply: input.autoApply } : {}),
            ...(input.staleDays !== undefined ? { staleDays: input.staleDays } : {}),
        };
        const feed = next.feed !== undefined ? next.feed : this.options.config.defaults.feed;
        const feedChanged = (feed ? feedId(feed) : '') !== (current.feed ? feedId(current.feed) : '');
        if (feedChanged) {
            // A new feed starts over: its releases, and its own notices.
            delete next.notified;
            delete next.staleNotified;
            this.releases = [];
            this.checked = undefined;
            this.lastAttemptAt = undefined;
        }
        await this.options.store.updateSettings({ updates: next }, (): Record<string, SecretSetting | null> => {
            if (typeof input.token === 'string' && feed) {
                return {
                    [FEED_TOKEN_SETTING]: {
                        value: this.options.box.seal({
                            token: input.token.trim(),
                            feed: feedId(feed),
                        }),
                        url: feedId(feed),
                    },
                };
            }
            // Removed, or the feed it was for is gone.
            if (input.token === null || feedChanged || !feed) {
                return { [FEED_TOKEN_SETTING]: null };
            }
            return {};
        });
        this.lastToken = undefined;
    }

    /** Back to the environment's settings; the saved token goes too. */
    async resetSettings() {
        const before = this.settings().feed;
        const after = this.options.config.defaults.feed;
        const { notified, staleNotified } = this.saved();
        const same = (before ? feedId(before) : '') === (after ? feedId(after) : '');
        const told = {
            ...(notified ? { notified } : {}),
            ...(staleNotified ? { staleNotified } : {}),
        };
        await this.options.store.updateSettings({ updates: same && notified ? told : undefined }, () => ({
            [FEED_TOKEN_SETTING]: null,
        }));
        this.lastToken = undefined;
        this.releases = [];
        this.checked = undefined;
        this.lastAttemptAt = undefined;
    }

    /** Whether a scheduled check is due now. */
    due() {
        const { feed, checkHours } = this.settings();
        if (!feed || !checkHours) {
            return false;
        }
        if (this.lastAttemptAt === undefined) {
            return true;
        }
        const failed = this.checked && !this.checked.ok;
        const wait = failed ? Math.min(checkHours * HOUR, HOUR) : checkHours * HOUR;
        return this.now() - this.lastAttemptAt >= wait;
    }

    /** Checks the feed now (one check at a time); never throws. */
    check(): Promise<void> {
        if (this.checking) {
            return this.checking;
        }
        this.checking = this.runCheck().finally(() => {
            this.checking = undefined;
        });
        return this.checking;
    }

    private async runCheck() {
        const { feed } = this.settings();
        const at = this.now();
        this.lastAttemptAt = at;
        if (!feed) {
            this.checked = { at, ok: false, error: 'No release feed is configured.' };
            return;
        }
        const token = this.token(feed);
        try {
            const releases = await fetchReleases({
                feed,
                token: token.value,
                githubApiUrl: this.options.config.githubApiUrl,
                ghcrUrl: this.options.config.ghcrUrl,
                transport: this.options.transport,
            });
            // The feed changed while this ran: its answer is for another one.
            const now = this.settings().feed;
            if (!now || feedId(now) !== feedId(feed)) {
                return;
            }
            this.releases = releases;
            this.checked = { at, ok: true };
        } catch (error) {
            const message = error instanceof UpdateFeedError ? error.message : 'The feed could not be read.';
            this.checked = {
                at,
                ok: false,
                error:
                    token.source === 'unreadable'
                        ? `${message} The saved token can’t be opened (its data key is gone): enter it again.`
                        : message,
            };
            this.options.log(`Updates: the check failed: ${message}`);
            return;
        }
        const available = this.available();
        this.options.log(
            available.length
                ? `Updates: ${available.length} newer release(s), the newest ${available[0]!.tag}.`
                : 'Updates: no newer release.',
        );
        await this.notify(available);
        await this.autoApply(available);
    }

    /** Newer than the running build, newest first. */
    available() {
        return newerReleases(this.releases, this.options.running().version);
    }

    /** The running release's date: the feed's, else the build's release notes'. */
    private runningDate(version: string) {
        return (
            this.releases.find((release) => release.version === version && release.date)?.date ??
            this.options.runningDate?.()
        );
    }

    /** Whether this server is behind enough to warn (CB-323); a warning only. */
    staleness(available = this.available()): UpdateStaleness | undefined {
        return updateStaleness({
            available,
            runningDate: this.runningDate(this.options.running().version),
            staleDays: this.settings().staleDays,
        });
    }

    /**
     * Operators hear of each new newest release once. When this server is
     * stale (CB-323), that notice is the staleness warning instead, also
     * once per newest release: a lower window or a security release
     * coming to light warns once even when the release was told before.
     */
    private async notify(available: FeedRelease[]) {
        const newest = available[0];
        if (!newest) {
            return;
        }
        const saved = this.saved();
        const stale = this.staleness(available);
        const warn = !!stale && saved.staleNotified !== newest.version;
        if (!warn && saved.notified === newest.version) {
            return;
        }
        await this.options.store.updateSettings({
            updates: {
                ...saved,
                notified: newest.version,
                ...(warn ? { staleNotified: newest.version } : {}),
            },
        });
        const { version } = this.options.running();
        await this.options
            .notifyOperators(
                warn
                    ? staleNotice(stale!, version)
                    : {
                          trigger: 'update_available',
                          title: `Socio ${newest.tag} is available`,
                          message: `This server runs ${version}. Read its notes and Upgrading steps on the Platform page before updating.`,
                          path: '/settings/operator',
                      },
            )
            .catch(() => undefined);
    }

    /**
     * Automatic updates, when an operator turned them on: only releases with
     * notes and no Upgrading steps (`autoApplyTarget`), never one whose
     * update failed or rolled back before, and never over an update going on.
     */
    private async autoApply(available: FeedRelease[]) {
        if (!this.settings().autoApply || !this.updater || this.preparingState) {
            return;
        }
        const target = autoApplyTarget(available, this.options.running().version);
        if (!target) {
            return;
        }
        let status: UpdaterStatus;
        try {
            status = await this.updater.status();
        } catch {
            return;
        }
        const jobs = [status.job, ...status.history].filter((job) => job !== null);
        if (status.job && !FINISHED_PHASES.includes(status.job.phase)) {
            return;
        }
        if (jobs.some((job) => job.target === target.tag && job.phase !== 'succeeded')) {
            this.options.log(`Updates: not applying ${target.tag} automatically: its last update did not succeed.`);
            return;
        }
        try {
            await this.apply(target.tag, 'auto', { confirmed: false });
            this.options.log(`Updates: applying ${target.tag} automatically.`);
        } catch (error) {
            this.options.log(
                `Updates: not applying ${target.tag} automatically: ${error instanceof Error ? error.message : 'unknown error'}`,
            );
        }
    }

    /**
     * Starts an update to `tag`: checks it is a newer release of the feed
     * and that its Upgrading steps were confirmed, then, in the background,
     * takes the mandatory backup and hands the update to the updater.
     */
    async apply(tag: string, requestedBy: string, { confirmed }: { confirmed: boolean }) {
        if (!this.updater) {
            throw new UpdatesError(
                'not_configured',
                'No updater is configured (UPDATER_URL): apply updates through your deployment.',
            );
        }
        if (!UPDATE_TAG.test(tag)) {
            throw new UpdatesError('invalid', 'Give a release tag such as v0.22.0.');
        }
        const { version } = this.options.running();
        const release = this.releases.find((item) => item.tag === tag);
        if (!release) {
            throw new UpdatesError(
                'unknown_release',
                'That release isn’t in the feed’s last answer: check for updates first.',
            );
        }
        if (compareVersions(release.version, version) <= 0) {
            throw new UpdatesError('not_newer', `${tag} is not newer than the running ${version}.`);
        }
        if (!confirmed && needsConfirmation(this.releases, version, release.version)) {
            throw new UpdatesError(
                'confirm_required',
                'Confirm the Upgrading steps of every release up to this one first.',
            );
        }
        const backups = this.options.backups();
        if (!backups) {
            throw new UpdatesError(
                'no_backups',
                'Backups aren’t running in this server: an update needs a backup first.',
            );
        }
        if (this.preparingState?.phase === 'backing_up' || this.starting) {
            throw new UpdatesError('busy', 'An update is being prepared.');
        }
        this.starting = true;
        try {
            let status: UpdaterStatus;
            try {
                status = await this.updater.status();
            } catch (error) {
                throw new UpdatesError(
                    'updater_unavailable',
                    error instanceof Error ? error.message : 'The updater is unreachable.',
                );
            }
            if (status.job && !FINISHED_PHASES.includes(status.job.phase)) {
                throw new UpdatesError('busy', 'The updater is applying an update.');
            }
        } finally {
            this.starting = false;
        }
        const startedAt = this.now();
        this.preparingState = {
            target: tag,
            requestedBy,
            phase: 'backing_up',
            startedAt,
        };
        this.preparingRun = this.prepare(tag, version, requestedBy, backups);
        return this.preparingState;
    }

    private async prepare(tag: string, from: string, requestedBy: string, backups: BackupsShape) {
        const { log } = this.options;
        try {
            log(`Updates: backing up before updating to ${tag}.`);
            const result = await backups.run();
            if (!result) {
                throw new Error(
                    `The pre-update backup failed${backups.status().lastError ? ` (${backups.status().lastError})` : ''}. Nothing was changed.`,
                );
            }
            if (backups.status().offsite && (result.offsiteError || !result.offsite)) {
                throw new Error(
                    `The pre-update backup’s off-site copy failed${result.offsiteError ? ` (${result.offsiteError})` : ''}. Nothing was changed.`,
                );
            }
            await this.updater!.apply({
                target: tag,
                from,
                requestedBy,
                backup: {
                    database: basename(result.database),
                    userdata: basename(result.userdata),
                    offsite: !!result.offsite,
                    at: this.now(),
                },
            });
            log(`Updates: the updater is applying ${tag}.`);
            this.preparingState = undefined;
        } catch (error) {
            const message = error instanceof UpdaterError || error instanceof Error ? error.message : 'unknown error';
            log(`Updates: the update to ${tag} did not start: ${message}`);
            this.preparingState = {
                target: tag,
                requestedBy,
                phase: 'failed',
                startedAt: this.preparingState?.startedAt ?? this.now(),
                error: message,
            };
        }
    }

    /** Resolves once the app's part of an update (the backup, the hand-off) is done. */
    async idle() {
        await this.checking;
        await this.preparingRun;
    }

    /** `GET /api/updates`. */
    async view(): Promise<UpdatesView> {
        const settings = this.settings();
        const running = this.options.running();
        const available = this.available();
        let updater: UpdatesView['updater'] = { configured: !!this.updater };
        if (this.updater) {
            try {
                updater = {
                    configured: true,
                    reachable: true,
                    status: await this.updater.status(),
                };
            } catch (error) {
                updater = {
                    configured: true,
                    reachable: false,
                    error: error instanceof Error ? error.message : 'The updater is unreachable.',
                };
            }
        } else if (this.options.config.updaterProblem) {
            updater = {
                configured: false,
                error: this.options.config.updaterProblem,
            };
        }
        const backups = this.options.backups();
        const auto = settings.autoApply ? autoApplyTarget(available, running.version) : undefined;
        const stale = this.staleness(available);
        const nextAt =
            settings.feed && settings.checkHours && this.lastAttemptAt !== undefined
                ? this.lastAttemptAt +
                  (this.checked && !this.checked.ok
                      ? Math.min(settings.checkHours * HOUR, HOUR)
                      : settings.checkHours * HOUR)
                : undefined;
        return {
            current: running,
            settings,
            defaults: this.options.config.defaults,
            token: this.token(settings.feed).source,
            check: {
                running: !!this.checking,
                ...this.checked,
                ...(nextAt ? { nextAt } : {}),
            },
            available,
            ...(stale ? { stale } : {}),
            ...(auto ? { autoTarget: auto.tag } : {}),
            updater,
            ...(this.preparingState ? { preparing: this.preparingState } : {}),
            backups: {
                running: !!backups?.status().running,
                offsite: !!backups?.status().offsite,
            },
        };
    }

    /** The saved token's seal, for the data key's counts (CB-62). */
    sealStates() {
        const counts = { current: 0, previous: 0, legacy: 0, unknown: 0 };
        const sealed = this.options.store.secretSetting(FEED_TOKEN_SETTING)?.value;
        if (sealed) {
            counts[this.options.box.state(this.options.box.valueKey(sealed))]++;
        }
        return counts;
    }

    /** Seals the saved token again under the current data key; idempotent. */
    async reseal() {
        const result = { resealed: 0, unreadable: 0 };
        const sealed = this.options.store.secretSetting(FEED_TOKEN_SETTING)?.value;
        if (!sealed) {
            return result;
        }
        let next: string | undefined;
        try {
            next = this.options.box.reseal(sealed);
        } catch {
            result.unreadable++;
            return result;
        }
        if (next && (await this.options.store.replaceSecretSetting(FEED_TOKEN_SETTING, sealed, next))) {
            result.resealed++;
        }
        this.lastToken = undefined;
        return result;
    }
}
