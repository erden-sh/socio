import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';

import type { SecretSetting, SecretSettingsShape } from './contract.js';

/**
 * The `SecretSettings` slice (`contract.ts`): `secret_settings` (CB-204),
 * sealed under the data key and kept out of `settings`, on the store's
 * connection. Moved from the old store facade as it was.
 */
export class SqliteSecretSettings implements SecretSettingsShape {
    constructor(private db: DatabaseSync) {}
    /** A secret setting's sealed value and URL (CB-204); never in `settings()`. */
    secretSetting(name: string): SecretSetting | undefined {
        const row = this.db.prepare('SELECT value, url FROM secret_settings WHERE name=?').get(name) as
            | { value: string; url: string | null }
            | undefined;
        return row && { value: row.value, url: row.url };
    }
    /** A secret setting sealed again, unless it changed meanwhile (CB-62). */
    replaceSecretSetting(name: string, previous: string, next: string) {
        return sqliteData(this.db).uow.run(
            async () => {
                const saved = this.secretSetting(name);
                if (saved?.value !== previous) {
                    return false;
                }
                this.write(name, { value: next, url: saved.url });
                return true;
            },
            { label: 'reseal secret setting' },
        );
    }
    /**
     * Sets or (null) clears one. Inside a unit of work only: this slice's,
     * or a settings save's (`SqliteWorkspaceSettings.updateSettings`).
     */
    write(name: string, secret: SecretSetting | null) {
        if (secret === null) {
            this.db.prepare('DELETE FROM secret_settings WHERE name=?').run(name);
        } else {
            this.db
                .prepare(
                    'INSERT INTO secret_settings (name, value, url) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, url=excluded.url',
                )
                .run(name, secret.value, secret.url ?? null);
        }
    }
}
