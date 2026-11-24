import type { DatabaseSync } from 'node:sqlite';

import { transaction, writeSoon } from '@socio/data/open';
import type { PluginManifest } from '@socio/shared/plugins/plugins';
import type { User } from '@socio/shared/types';
import { compareVersions, isReleaseVersion } from '@socio/shared/updates/release-seen';
import { WHATS_NEW_SEEN_MAX_PLUGINS, type PluginReleaseNotesCard } from '@socio/shared/updates/whats-new';

import type { InstalledPlugin } from './contract.js';
import { SqlitePluginReleaseNotes } from './infra/release-notes.js';

/** What the release notes need of the plugin service. */
export interface ReleaseNotesHost {
    /** Installed plugins, as this process reads them now. */
    installs(): InstalledPlugin[];
    /** The same check as opening the plugin. */
    mayUse(row: InstalledPlugin | undefined, person: User | undefined): boolean;
    /** Everyone who can sign in now. */
    users(): User[];
    log(line: string): void;
}

/**
 * Plugins' release notes (CB-527). A plugin's manifest notes are read at
 * install and update (a bundled plugin's when Socio's build brings a new
 * version), never fetched live. Who sees them is who may open the plugin
 * now (`mayUse`), on every read:
 *
 * - At an install, everyone who may open it starts at its version: an
 *   install is not an update, so it shows no modal.
 * - At an update, everyone who may open it and has no seen version yet
 *   starts at the version before, so the update is new to them; everyone
 *   who may not forgets what they saw of it.
 * - Someone who can't open it now gets no card and forgets what they saw;
 *   someone who can and has no seen version (they gained access since the
 *   last update, or joined) starts at the installed version: its stored
 *   history shows, folded, with no modal for what came before.
 */
export class PluginReleaseNotes {
    private rows: SqlitePluginReleaseNotes;

    constructor(
        private db: DatabaseSync,
        private host: ReleaseNotesHost,
        private now: () => number = Date.now,
    ) {
        this.rows = new SqlitePluginReleaseNotes(db);
    }

    /**
     * Reads `manifest`'s notes for an install (`from` undefined) or an
     * update from `from`. Never throws: notes that fail to record are logged
     * and the install or update stands.
     */
    async record(id: string, manifest: PluginManifest, from: string | undefined) {
        if (!this.rows.exists()) {
            return;
        }
        try {
            const row = this.host.installs().find((item) => item.id === id);
            const people = this.host.users();
            const now = this.now();
            const version = manifest.version;
            const baseline = from !== undefined && isReleaseVersion(from) ? from : version;
            await transaction(this.db, 'record plugin release notes', () => {
                this.rows.record(id, manifest.releaseNotes ?? [], version, now);
                this.sweep(id, row, people, isReleaseVersion(version) ? baseline : undefined, now);
            });
        } catch (error) {
            this.host.log(
                `Plugins: recording ${id}’s release notes failed (${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}).`,
            );
        }
    }

    /** Who may no longer open the plugin (an audience change, a disable) forgets what they saw. */
    async accessChanged(id: string) {
        if (!this.rows.exists()) {
            return;
        }
        try {
            const row = this.host.installs().find((item) => item.id === id);
            const people = this.host.users();
            await transaction(this.db, 'plugin release notes access', () =>
                this.sweep(id, row, people, undefined, this.now()),
            );
        } catch {
            this.host.log(`Plugins: updating who saw ${id}’s release notes failed.`);
        }
    }

    /** Uninstalled: its notes go with it. */
    async forget(id: string) {
        if (!this.rows.exists()) {
            return;
        }
        await transaction(this.db, 'forget plugin release notes', () => this.rows.forget(id)).catch(() =>
            this.host.log(`Plugins: removing ${id}’s release notes failed.`),
        );
    }

    /**
     * People who may open the plugin start at `baseline` when they have no
     * seen version (none given: they are left as they are); the rest, and
     * anyone who can't sign in now, forget what they saw.
     */
    private sweep(
        id: string,
        row: InstalledPlugin | undefined,
        people: User[],
        baseline: string | undefined,
        now: number,
    ) {
        const allowed = new Set<string>();
        for (const person of people) {
            if (this.host.mayUse(row, person)) {
                allowed.add(person.id);
                if (baseline) {
                    this.rows.start(person.id, id, baseline, now);
                }
            }
        }
        for (const userId of this.rows.seers(id)) {
            if (!allowed.has(userId)) {
                this.rows.drop(userId, id);
            }
        }
    }

    /**
     * A bundled plugin updates with Socio: its build's notes are read the
     * first time this build serves them, as an update from the version read
     * before (the first time ever, as an install).
     */
    async syncBundled() {
        if (!this.rows.exists()) {
            return;
        }
        for (const row of this.host.installs()) {
            if (row.mode !== 'bundled') {
                continue;
            }
            const recorded = this.rows.recordedVersion(row.id);
            if (recorded !== row.manifest.version) {
                await this.record(row.id, row.manifest, recorded);
            }
        }
    }

    /**
     * The cards `person` sees: one per installed plugin they may open now
     * with stored notes, by name. Their seen version starts at the installed
     * one when they have none; a plugin they can't open is forgotten.
     */
    async cards(person: User): Promise<PluginReleaseNotesCard[]> {
        if (!this.rows.exists()) {
            return [];
        }
        await this.syncBundled();
        const cards: PluginReleaseNotesCard[] = [];
        const writes: Array<() => void> = [];
        const now = this.now();
        for (const row of this.host.installs()) {
            const had = this.rows.seen(person.id, row.id);
            if (!this.host.mayUse(row, person)) {
                if (had) {
                    writes.push(() => this.rows.drop(person.id, row.id));
                }
                continue;
            }
            const version = row.manifest.version;
            if (!isReleaseVersion(version)) {
                continue;
            }
            if (!had) {
                writes.push(() => this.rows.start(person.id, row.id, version, now));
            }
            // A version above the installed one (a rollback) isn't shown.
            const releases = this.rows.notes(row.id).filter((note) => compareVersions(note.version, version) <= 0);
            if (!releases.length) {
                continue;
            }
            const lastSeen = had && compareVersions(had, version) <= 0 ? had : version;
            cards.push({
                id: row.id,
                name: row.manifest.name,
                ...(row.manifest.icon ? { icon: row.manifest.icon } : {}),
                version,
                lastSeen,
                releases,
            });
        }
        if (writes.length) {
            writeSoon(this.db, 'plugin release notes seen', () => {
                for (const write of writes) {
                    write();
                }
            });
        }
        return cards.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    }

    /**
     * `person` saw these versions: each moves forward, never back, and only
     * for a plugin they may open now, to its installed version or one of its
     * stored notes'. Anything else is left as it was.
     */
    async markSeen(person: User, plugins: Readonly<Record<string, string>>) {
        if (!this.rows.exists()) {
            return;
        }
        const now = this.now();
        const asked = Object.entries(plugins).slice(0, WHATS_NEW_SEEN_MAX_PLUGINS);
        const installs = this.host.installs();
        await transaction(this.db, 'plugin release notes seen', () => {
            for (const [id, version] of asked) {
                const row = installs.find((item) => item.id === id);
                if (!row || !this.host.mayUse(row, person) || !isReleaseVersion(version)) {
                    continue;
                }
                const installed = row.manifest.version;
                if (!isReleaseVersion(installed) || compareVersions(version, installed) > 0) {
                    continue;
                }
                if (version !== installed && !this.rows.notes(id).some((note) => note.version === version)) {
                    continue;
                }
                this.rows.advance(person.id, id, version, now);
            }
        });
    }
}
