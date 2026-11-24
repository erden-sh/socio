import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';
import type { Settings } from '@socio/shared/types';
import { TRANSCRIPTION_KEY_SETTING } from '@socio/shared/voice/settings-keys';

import type { SecretSettingChanges, SettingsPatch, WorkspaceSettingsShape } from './contract.js';
import type { SqliteSecretSettings } from './secret-settings.js';

/**
 * The `WorkspaceSettings` slice (`contract.ts`): the one `settings` row, on
 * the store's connection. Moved from the old store facade as it was; what a save also
 * touches comes in prepared: the secret settings it writes in the same unit
 * of work, and the running tasks it interrupts (the Scheduling context's
 * `interruptRunning`, which the store's `TaskService` has).
 */
export class SqliteWorkspaceSettings implements WorkspaceSettingsShape {
    /** Final policy for dependents that finish flushing after the store's own connection closes. */
    private closedSettings?: Settings;
    constructor(
        private db: DatabaseSync,
        private secrets: Pick<SqliteSecretSettings, 'write'>,
        private interruptRunning: (reason: string) => Promise<unknown>,
    ) {}
    /**
     * Keeps the settings as they are now for `settingsSnapshot`: the store
     * calls it just before it closes a connection it opened.
     */
    keepFinal() {
        this.closedSettings = this.settings();
    }
    /**
     * Live settings, or the final snapshot captured before closing our connection.
     * Teardown consumers may outlive a separately owned settings database; ordinary
     * settings() keeps its live-database contract and still fails after close.
     */
    settingsSnapshot(): Settings {
        return this.closedSettings ?? this.settings();
    }
    settings(): Settings {
        const row = this.db.prepare('SELECT value FROM settings WHERE id=1').get() as { value: string };
        return JSON.parse(row.value) as Settings;
    }
    /**
     * Saves the settings; turning work off (a pause, research or memory)
     * interrupts the tasks running, in the same unit of work (CB-110).
     * `secrets` sets (sealed) or clears secret settings with them, from the
     * settings as saved; it may throw to save nothing. A new transcription
     * URL clears its key first (CB-204), so a key can't be sent somewhere
     * new by editing the URL alone.
     */
    updateSettings(change: SettingsPatch, secrets?: SecretSettingChanges): Promise<Settings> {
        return sqliteData(this.db).uow.run(
            async () => {
                const previous = this.settings();
                const patch = typeof change === 'function' ? change(previous) : change;
                const settings = { ...previous, ...patch };
                // Raw SQL in this unit's own context: part of its transaction.
                this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(settings));
                if ('transcription' in patch && previous.transcription?.url !== settings.transcription?.url) {
                    this.secrets.write(TRANSCRIPTION_KEY_SETTING, null);
                }
                for (const [name, secret] of Object.entries(secrets?.(settings) ?? {})) {
                    this.secrets.write(name, secret);
                }
                if (
                    (!previous.paused && settings.paused) ||
                    (previous.researchAllowed && !settings.researchAllowed) ||
                    (previous.memoryAllowed && !settings.memoryAllowed)
                ) {
                    await this.interruptRunning(
                        'Run interrupted because settings changed. Review completed effects before retrying.',
                    );
                }
                return settings;
            },
            { label: 'update settings' },
        );
    }
}
