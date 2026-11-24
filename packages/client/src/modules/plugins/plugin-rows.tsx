import { CalendarDays, Puzzle, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import type {
    PluginBackupHistoryEntry,
    PluginBackupState,
    PluginStorageWarning,
} from '@socio/shared/plugins/plugin-backup';
import type { PluginConfigField } from '@socio/shared/plugins/plugin-config';
import type { PluginUpdateReview } from '@socio/shared/plugins/plugin-update';
import { OPEN_ANY_HTTPS_LABEL } from '@socio/shared/plugins/plugins';

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

const BADGES: Partial<Record<PluginBackupState, { label: string; slot: string; destructive: boolean }>> = {
    not_backed_up: { label: 'Not backed up', slot: 'plugin-not-backed-up', destructive: true },
    failing: { label: 'Backup failing', slot: 'plugin-backup-failing', destructive: true },
    stale: { label: 'Backup out of date', slot: 'plugin-backup-stale', destructive: false },
};

/** The badge for a plugin whose state isn't safely backed up (CB-458); nothing for one that is, or keeps none. */
export function BackupBadge({ backup }: { backup?: PluginBackupInfo }) {
    const badge = backup && BADGES[backup.state];
    if (!backup || !badge) {
        return null;
    }
    const destructive = badge.destructive && !(backup.state === 'not_backed_up' && backup.declared);
    return (
        <Badge variant={destructive ? 'destructive' : 'outline'} data-slot={badge.slot}>
            {badge.label}
        </Badge>
    );
}

/** Bytes in the largest unit that keeps a whole number in front: KB, MB or GB. */
export function backupSize(bytes: number) {
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
}

const localWhen = (ms: number) => new Date(ms).toLocaleString();

/** What the plugin's page says about its backups (CB-458). */
export function backupDetail(backup: PluginBackupInfo, when: (ms: number) => string = localWhen) {
    const volumes = backup.volumes.join(', ');
    const last =
        backup.lastSuccessAt !== undefined
            ? `Last backed up ${when(backup.lastSuccessAt)}${backup.sizeBytes !== undefined ? ` (${backupSize(backup.sizeBytes)})` : ''}.`
            : 'It has no good backup yet.';
    switch (backup.state) {
        case 'ok':
            return `Its own storage (${volumes}) is backed up with every scheduled backup. ${last}`;
        case 'stale':
            return `Its own storage (${volumes}) hasn’t been backed up for more than two backup intervals. ${last}`;
        case 'failing':
            return `Its last backup failed${backup.lastErrorAt !== undefined ? ` (${when(backup.lastErrorAt)})` : ''}: ${backup.lastError ?? 'no reason given'} ${last}`;
        case 'disabled':
            return `It is disabled${backup.since !== undefined ? ` since ${when(backup.since)}` : ''}, so it isn’t backed up; its backups stay. ${last}`;
        case 'not_backed_up':
            return backup.declared
                ? `It keeps data on its own storage (${volumes}) and declares backups. Its first backup comes with the next scheduled backup, or use Back up now.`
                : `It keeps data on its own storage (${volumes}), and the installed version doesn’t declare backups, so the workspace’s backups don’t include it. Once its catalog entry declares service.backup, apply its Update. A later release refuses to install or update it without one.`;
    }
}

/** Whether the plugin's page shows its backup line in red. */
export const backupAlarm = (backup: PluginBackupInfo) =>
    backup.state === 'failing' || (backup.state === 'not_backed_up' && !backup.declared);

/** The catalog's storage warnings for an entry (CB-458), before install. */
export function StorageWarnings({ warnings }: { warnings?: PluginStorageWarning[] }) {
    if (!warnings?.length) {
        return null;
    }
    return (
        <ul className="grid gap-1 text-sm" data-slot="plugin-storage-warnings">
            {warnings.map((warning) => (
                <li key={warning.kind} className="flex flex-wrap items-start gap-2" data-warning={warning.kind}>
                    <Badge variant={warning.kind === 'not_backed_up' ? 'destructive' : 'outline'}>
                        <ShieldAlert aria-hidden="true" />{' '}
                        {warning.kind === 'not_backed_up' ? 'Not backed up' : 'Private storage'}
                    </Badge>
                    <span>{warning.message}.</span>
                </li>
            ))}
        </ul>
    );
}

export interface PluginList {
    catalog: CatalogRow[];
    installed: InstalledRow[];
}

export const PERMISSIONS: Record<string, string> = {
    'social:read': 'Read planned posts and the reply queue',
    'social:write': 'Edit planned posts and replies',
    'calendar:read': 'Read calendar events',
    'calendar:write': 'Add, change and delete calendar events',
    'person:read': 'See who is using it: their name, role and time zone (signed by Socio)',
};

export const AUDIENCE_LABEL: Record<Audience, string> = {
    admins: 'Admins only',
    members: 'Everyone (members too)',
};

export const failed = (error: unknown, fallback: string) =>
    toast.error(error instanceof Error ? error.message : fallback);

/** A plugin's own admin page (CB-393), outside the plugin's address (CB-446). */
export const managePath = (id: string) => `/settings/plugins/${encodeURIComponent(id)}`;

/** A plugin's own address: its frame, or a tab plugin's launch page (CB-446). */
export const pluginPath = (id: string) => `/plugins/${encodeURIComponent(id)}`;

/** The Plugins page's Installed tab, the overview. */
export const INSTALLED_PATH = '/plugins?tab=installed';

export function permissionLine(permissions: string[]) {
    if (!permissions.length) {
        return 'Asks for no extra permissions.';
    }
    return `${permissions.map((item) => PERMISSIONS[item] ?? item).join('. ')}.`;
}

/**
 * The sensitive `bridge.openAnyHttps` scope as every review shows it (the
 * install page, the plugin's own page, an update that adds it): a
 * "Sensitive scope" warning and what it lets the plugin do.
 */
export function OpenAnyHttpsScope({ as: Tag = 'p' }: { as?: 'p' | 'li' }) {
    return (
        <Tag className="flex flex-wrap items-start gap-2 text-sm" data-slot="plugin-sensitive-scope">
            <Badge variant="destructive">
                <ShieldAlert aria-hidden="true" /> Sensitive scope
            </Badge>
            <span>
                <span className="font-medium text-foreground">bridge.openAnyHttps</span>
                {' · '}
                {OPEN_ANY_HTTPS_LABEL}
            </span>
        </Tag>
    );
}

export function displayLabel(display: 'tab' | 'embed', mode: Mode = 'service') {
    if (mode === 'bundled') {
        return 'Opens inside Socio';
    }
    return display === 'embed' ? 'Opens inside Socio' : 'Opens in a new tab';
}

export function modeLabel(mode: Mode = 'service') {
    return mode === 'bundled' ? 'Runs inside Socio' : 'Runs as its own service';
}

export function runLabel(plugin: InstalledRow) {
    if (!plugin.enabled) {
        return 'Disabled';
    }
    if (plugin.mode === 'bundled') {
        return 'Runs inside Socio';
    }
    if (plugin.running > 0) {
        return `${plugin.running} of ${plugin.replicas} running`;
    }
    if (plugin.state === 'stopped') {
        return 'Stopped';
    }
    return 'Starting';
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
    const bundled = plugin.mode === 'bundled';
    return (
        <Button variant={variant} size="sm" asChild>
            <Link to={pluginPath(plugin.id)} reloadDocument={!bundled && plugin.display === 'embed'}>
                Open
            </Link>
        </Button>
    );
}
