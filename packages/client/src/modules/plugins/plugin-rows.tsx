import { CalendarDays, Puzzle, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type {
    PluginBackupHistoryEntry,
    PluginBackupState,
    PluginStorageWarning,
} from '@socio/shared/plugins/plugin-backup';
import type { PluginConfigField } from '@socio/shared/plugins/plugin-config';
import type { PluginUpdateReview } from '@socio/shared/plugins/plugin-update';
import { OPEN_ANY_HTTPS_SCOPE } from '@socio/shared/plugins/plugins';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * What `/api/plugins` says about plugins, and the small pieces the Plugins
 * overview and a plugin's own page share.
 */
export type Audience = 'admins' | 'members';
export type Mode = 'service' | 'bundled';

export interface CatalogRow {
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    display: 'tab' | 'embed';
    mode?: Mode;
    audience?: Audience;
    permissions: string[];
    /** The manifest's `bridge.openAnyHttps`, a sensitive scope. */
    openAnyHttps?: boolean;
    icon: string;
    installed: boolean;
    /** What its storage asks of the admin before install (CB-458): no backup, private storage. */
    storageWarnings?: PluginStorageWarning[];
}

/** One setting a manifest declares under `config`, typed since CB-395. */
export type ConfigField = PluginConfigField;

export interface InstalledRow {
    id: string;
    name: string;
    description: string;
    author: string;
    version: string;
    permissions: string[];
    /** The installed manifest's `bridge.openAnyHttps`, a sensitive scope. */
    openAnyHttps?: boolean;
    icon: string;
    enabled: boolean;
    display: 'tab' | 'embed';
    replicas: number;
    /**
     * The catalog's newer manifest, which **Update** adopts (CB-370): what it
     * adds, which the admin reviews and acknowledges first (CB-531).
     */
    update?: PluginUpdateReview;
    running: number;
    state: string;
    origin: string;
    mode?: Mode;
    audience?: Audience;
    config?: Record<string, string>;
    /** The manifest's settings, when it has any (descriptions, defaults, types). */
    configFields?: Record<string, ConfigField>;
    /**
     * A service plugin's outbound hosts as its stored settings give them
     * (CB-441): `hosts` is the allow list; each `fromConfig` setting says
     * which host it added, or why none.
     */
    egress?: {
        hosts: string[];
        settings: { field: string; host?: string; problem?: string }[];
    };
    /** A plugin that keeps state on its own volumes (CB-458): whether the workspace backs it up. */
    backup?: PluginBackupInfo;
}

/** An installed plugin's backup status (CB-458), as `/api/plugins` gives it. */
export interface PluginBackupInfo {
    state: PluginBackupState;
    /** Its manifest declares `service.backup`. */
    declared: boolean;
    /** Its volumes that hold state. */
    volumes: string[];
    /** Since when it is failing, disabled, or flagged without a backup. */
    since?: number;
    /** Its last good snapshot, and its size in bytes. */
    lastSuccessAt?: number;
    sizeBytes?: number;
    /** Its last failed snapshot, and why. */
    lastErrorAt?: number;
    lastError?: string;
    /** A snapshot of it is being taken now. */
    running?: boolean;
}

/** What `/api/plugins/:id/backups` answers: the status, and the stored snapshots, newest first. */
export interface PluginBackups {
    backup: PluginBackupInfo;
    history: PluginBackupHistoryEntry[];
}

const BADGES: Partial<Record<PluginBackupState, { slot: string; destructive: boolean }>> = {
    not_backed_up: { slot: 'plugin-not-backed-up', destructive: true },
    failing: { slot: 'plugin-backup-failing', destructive: true },
    stale: { slot: 'plugin-backup-stale', destructive: false },
};

/** The badge for a plugin whose state isn't safely backed up (CB-458); nothing for one that is, or keeps none. */
export function BackupBadge({ backup }: { backup?: PluginBackupInfo }) {
    const { t } = useTranslation(['plugins']);
    const badge = backup && BADGES[backup.state];
    if (!backup || !badge) {
        return null;
    }
    const destructive = badge.destructive && !(backup.state === 'not_backed_up' && backup.declared);
    return (
        <Badge variant={destructive ? 'destructive' : 'outline'} data-slot={badge.slot}>
            {t(`plugins:backup-badge.${backup.state as 'not_backed_up' | 'failing' | 'stale'}`)}
        </Badge>
    );
}

/** Whether the plugin's page shows its backup line in red. */
export const backupAlarm = (backup: PluginBackupInfo) =>
    backup.state === 'failing' || (backup.state === 'not_backed_up' && !backup.declared);

/** The catalog's storage warnings for an entry (CB-458), before install. */
export function StorageWarnings({ warnings }: { warnings?: PluginStorageWarning[] }) {
    const { t } = useTranslation(['plugins']);
    if (!warnings?.length) {
        return null;
    }
    return (
        <ul className="grid gap-1 text-sm" data-slot="plugin-storage-warnings">
            {warnings.map((warning) => (
                <li key={warning.kind} className="flex flex-wrap items-start gap-2" data-warning={warning.kind}>
                    <Badge variant={warning.kind === 'not_backed_up' ? 'destructive' : 'outline'}>
                        <ShieldAlert aria-hidden="true" />{' '}
                        {warning.kind === 'not_backed_up'
                            ? t('plugins:storage-warning.not-backed-up')
                            : t('plugins:storage-warning.private')}
                    </Badge>
                    {/* The catalog's own words (the server's), like a manifest's. */}
                    <span>{t('plugins:storage-warning.message', { message: warning.message })}</span>
                </li>
            ))}
        </ul>
    );
}

export interface PluginList {
    catalog: CatalogRow[];
    installed: InstalledRow[];
}

/** The permissions Socio knows, by scope; a scope it doesn't know shows as itself. */
const PERMISSIONS = {
    'social:read': 'social-read',
    'social:write': 'social-write',
    'calendar:read': 'calendar-read',
    'calendar:write': 'calendar-write',
    'person:read': 'person-read',
} as const;

export const failed = (error: unknown, fallback: string) =>
    toast.error(error instanceof Error ? error.message : fallback);

/** A plugin's own admin page (CB-393), outside the plugin's address (CB-446). */
export const managePath = (id: string) => `/settings/plugins/${encodeURIComponent(id)}`;

/** A plugin's own address: its frame, or a tab plugin's launch page (CB-446). */
export const pluginPath = (id: string) => `/plugins/${encodeURIComponent(id)}`;

/** The Plugins page's Installed tab, the overview. */
export const INSTALLED_PATH = '/plugins?tab=installed';

/**
 * The sensitive `bridge.openAnyHttps` scope as every review shows it (the
 * install page, the plugin's own page, an update that adds it): a
 * "Sensitive scope" warning and what it lets the plugin do.
 */
export function OpenAnyHttpsScope({ as: Tag = 'p' }: { as?: 'p' | 'li' }) {
    const { t } = useTranslation(['plugins']);
    return (
        <Tag className="flex flex-wrap items-start gap-2 text-sm" data-slot="plugin-sensitive-scope">
            <Badge variant="destructive">
                <ShieldAlert aria-hidden="true" /> {t('plugins:sensitive.badge')}
            </Badge>
            <span>
                <span className="font-medium text-foreground">{OPEN_ANY_HTTPS_SCOPE}</span>
                {' · '}
                {t('plugins:sensitive.open-any-https')}
            </span>
        </Tag>
    );
}

/**
 * The words the Plugins overview and a plugin's page say about a plugin, in
 * the reader's language: how it opens and runs, a permission, the line of
 * its permissions, and who may use it.
 */
export function usePluginWords() {
    const { t } = useTranslation(['plugins']);
    const permission = (scope: string) =>
        Object.hasOwn(PERMISSIONS, scope)
            ? t(`plugins:permissions.${PERMISSIONS[scope as keyof typeof PERMISSIONS]}`)
            : scope;
    return {
        displayLabel: (display: 'tab' | 'embed', mode: Mode = 'service') =>
            mode === 'bundled' || display === 'embed' ? t('plugins:display.inside') : t('plugins:display.tab'),
        modeLabel: (mode: Mode = 'service') =>
            mode === 'bundled' ? t('plugins:mode.bundled') : t('plugins:mode.service'),
        runLabel: (plugin: InstalledRow) => {
            if (!plugin.enabled) {
                return t('plugins:run.disabled');
            }
            if (plugin.mode === 'bundled') {
                return t('plugins:mode.bundled');
            }
            if (plugin.running > 0) {
                return t('plugins:run.running', { running: plugin.running, count: plugin.replicas });
            }
            return plugin.state === 'stopped' ? t('plugins:run.stopped') : t('plugins:run.starting');
        },
        permission,
        /** Its permissions as sentences, or that it asks for none. */
        permissionLine: (permissions: string[]) =>
            permissions.length
                ? permissions
                      .map((item) => t('plugins:permission-sentence', { permission: permission(item) }))
                      .join(' ')
                : t('plugins:no-permissions'),
        audienceLabel: (audience: Audience) =>
            audience === 'admins' ? t('plugins:audience.admins') : t('plugins:audience.members'),
    };
}

export function PluginMark({ id, large }: { id: string; large?: boolean }) {
    const Icon = id === 'social-strategy' || id === 'calendar' ? CalendarDays : Puzzle;
    return (
        <div
            className={cn(
                'grid shrink-0 place-items-center rounded-xl bg-muted text-primary',
                large ? 'size-14' : 'size-10',
            )}
        >
            <Icon className={large ? 'size-7' : 'size-5'} aria-hidden="true" />
        </div>
    );
}

/**
 * **Open** for an enabled plugin. An embed opens with a document navigation,
 * so that route's CSP (its `frame-src`) applies.
 */
export function OpenPlugin({ plugin, variant = 'default' }: { plugin: InstalledRow; variant?: 'default' | 'outline' }) {
    const { t } = useTranslation(['plugins']);
    const bundled = plugin.mode === 'bundled';
    return (
        <Button variant={variant} size="sm" asChild>
            <Link to={pluginPath(plugin.id)} reloadDocument={!bundled && plugin.display === 'embed'}>
                {t('plugins:open')}
            </Link>
        </Button>
    );
}
