import type { DatabaseSync } from 'node:sqlite';

import { PLUGIN_RELEASE_HISTORY_MAX, type PluginReleaseNote } from '@socio/shared/plugins/plugin-release-notes';
import { compareVersions, isReleaseVersion } from '@socio/shared/updates/release-seen';

interface NoteRow {
    version: string;
    date: string;
    title: string | null;
    notes: string;
}

/**
 * Plugins' release notes (plugins migration 5, CB-527):
 * `plugin_release_notes`, each installed plugin's notes by version, at most
 * `PLUGIN_RELEASE_HISTORY_MAX` kept; `plugin_release_state`, the version
 * they were last read for; and `plugin_release_seen`, the newest version
 * each person has seen of each plugin. Writes run inside the caller's
 * `transaction()`.
 */
export class SqlitePluginReleaseNotes {
    constructor(private db: DatabaseSync) {}

    exists() {
        return !!this.db
            .prepare("SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='plugin_release_seen'")
            .get();
    }

    // ---- notes -------------------------------------------------------------
    /** Newest first. */
    notes(pluginId: string): PluginReleaseNote[] {
        const rows = this.db
            .prepare('SELECT version, date, title, notes FROM plugin_release_notes WHERE pluginId=?')
            .all(pluginId) as unknown as NoteRow[];
        return rows
            .filter((row) => isReleaseVersion(row.version))
            .sort((a, b) => compareVersions(b.version, a.version))
            .map((row) => ({
                version: row.version,
                date: row.date,
                ...(row.title ? { title: row.title } : {}),
                notes: row.notes,
            }));
    }

    /**
     * Keeps `notes` (a version stored before takes the manifest's text now),
     * then only the newest `PLUGIN_RELEASE_HISTORY_MAX` versions.
     */
    record(pluginId: string, notes: readonly PluginReleaseNote[], version: string, now: number) {
        const upsert = this.db.prepare(
            'INSERT INTO plugin_release_notes VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(pluginId, version) DO UPDATE SET date=excluded.date, title=excluded.title, notes=excluded.notes, recordedAt=excluded.recordedAt',
        );
        for (const note of notes) {
            upsert.run(pluginId, note.version, note.date, note.title ?? null, note.notes, now);
        }
        const drop = this.db.prepare('DELETE FROM plugin_release_notes WHERE pluginId=? AND version=?');
        const all = (
            this.db.prepare('SELECT version FROM plugin_release_notes WHERE pluginId=?').all(pluginId) as Array<{
                version: string;
            }>
        ).map((row) => row.version);
        const ordered = all
            .filter((item) => isReleaseVersion(item))
            .sort((a, b) => compareVersions(b, a))
            .slice(0, PLUGIN_RELEASE_HISTORY_MAX);
        const keep = new Set(ordered);
        for (const item of all) {
            if (!keep.has(item)) {
                drop.run(pluginId, item);
            }
        }
        this.db
            .prepare(
                'INSERT INTO plugin_release_state VALUES (?, ?, ?) ON CONFLICT(pluginId) DO UPDATE SET version=excluded.version, recordedAt=excluded.recordedAt',
            )
            .run(pluginId, version, now);
    }

    /** The version the notes were last read for; undefined before the first. */
    recordedVersion(pluginId: string): string | undefined {
        const row = this.db.prepare('SELECT version FROM plugin_release_state WHERE pluginId=?').get(pluginId) as
            | { version: string }
            | undefined;
        return row?.version;
    }

    /** Uninstalled: its notes and who saw them go with it. */
    forget(pluginId: string) {
        this.db.prepare('DELETE FROM plugin_release_notes WHERE pluginId=?').run(pluginId);
        this.db.prepare('DELETE FROM plugin_release_state WHERE pluginId=?').run(pluginId);
        this.db.prepare('DELETE FROM plugin_release_seen WHERE pluginId=?').run(pluginId);
    }

    // ---- seen --------------------------------------------------------------
    seen(userId: string, pluginId: string): string | undefined {
        const row = this.db
            .prepare('SELECT version FROM plugin_release_seen WHERE userId=? AND pluginId=?')
            .get(userId, pluginId) as { version: string } | undefined;
        return row && isReleaseVersion(row.version) ? row.version : undefined;
    }

    /** Sets it when there is none, else leaves it. */
    start(userId: string, pluginId: string, version: string, now: number) {
        this.db
            .prepare('INSERT INTO plugin_release_seen VALUES (?, ?, ?, ?) ON CONFLICT(userId, pluginId) DO NOTHING')
            .run(userId, pluginId, version, now);
    }

    /** Moves it forward to `version`, never back. Answers the version kept. */
    advance(userId: string, pluginId: string, version: string, now: number) {
        const before = this.seen(userId, pluginId);
        if (before && compareVersions(version, before) <= 0) {
            return before;
        }
        this.db
            .prepare(
                'INSERT INTO plugin_release_seen VALUES (?, ?, ?, ?) ON CONFLICT(userId, pluginId) DO UPDATE SET version=excluded.version, seenAt=excluded.seenAt',
            )
            .run(userId, pluginId, version, now);
        return version;
    }

    /** They can't open it now: what they saw of it is forgotten. */
    drop(userId: string, pluginId: string) {
        this.db.prepare('DELETE FROM plugin_release_seen WHERE userId=? AND pluginId=?').run(userId, pluginId);
    }

    /** Who has a seen version for the plugin. */
    seers(pluginId: string): string[] {
        return (
            this.db.prepare('SELECT userId FROM plugin_release_seen WHERE pluginId=?').all(pluginId) as Array<{
                userId: string;
            }>
        ).map((row) => row.userId);
    }
}
