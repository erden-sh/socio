import { BarChart3, CalendarDays, ChevronRight, Search, Send } from 'lucide-react';
/**
 * Plugins catalog layout adapted from calcom/cal.diy (MIT),
 * apps/web/modules/apps and packages/app-store: category cards, Popular
 * and Recently added rows, an app detail page, and an Installed tab.
 * Copyright (c) Cal.com, Inc.
 *
 * Empty states borrow the spacing and type of satnaing/shadcn-admin (MIT).
 * Copyright (c) Sat Naing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import { AppCard, AppDetail, CatalogEmpty, CategoryCard, ScreenshotFrame } from '@socio/plugin-ui';
import { MODULE_IDS } from '@socio/shared/modules';
import type { PluginBindingPlan } from '@socio/shared/plugins/bindings';
import { OPEN_ANY_HTTPS_SCOPE } from '@socio/shared/plugins/plugins';

import { api } from '../../lib/api';
import { useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';

import {
    BackupBadge,
    failed,
    managePath,
    OpenAnyHttpsScope,
    OpenPlugin,
    PluginMark,
    StorageWarnings,
    usePluginWords,
    type CatalogRow,
    type InstalledRow,
    type PluginList,
} from './plugin-rows';
import { bindingsNeedAsking, PluginInstallDialog } from './PluginDatasetBindings';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** The featured categories; their names are plugins.catalog's (`categories.<id>`). */
const CATEGORIES: {
    id: 'scheduling' | 'publishing' | 'analytics';
    className: string;
    icon: typeof CalendarDays;
    match: (plugin: CatalogRow) => boolean;
}[] = [
    {
        id: 'scheduling',
        className: 'from-emerald-900 via-teal-800 to-slate-900',
        icon: CalendarDays,
        match: (plugin) =>
            plugin.permissions.some((item) => item.startsWith('social') || item.startsWith('calendar')) ||
            plugin.id === 'social-strategy' ||
            plugin.id === 'calendar',
    },
    {
        id: 'publishing',
        className: 'from-indigo-900 via-blue-800 to-slate-900',
        icon: Send,
        match: () => false,
    },
    {
        id: 'analytics',
        className: 'from-rose-900 via-orange-800 to-slate-900',
        icon: BarChart3,
        match: () => false,
    },
];

/**
 * `/plugins`: this instance's catalog and the services an admin has
 * installed. The catalog is empty until `PLUGIN_CATALOGS` names something.
 * Its words are the route's (plugins, plugins.catalog); the install
 * dialog's load on demand (plugins.bindings).
 */
export function PluginsPage() {
    const { t } = useTranslation(['plugins', 'plugins.catalog']);
    // The latest t, for callbacks and effects that shouldn't run again when the language changes.
    const latestT = useRef(t);
    latestT.current = t;
    const shell = useShell();
    const [params, setParams] = useSearchParams();
    const navigate = useNavigate();
    const [data, setData] = useState<PluginList>();
    const [query, setQuery] = useState('');
    const [category, setCategory] = useState<string>();
    const tab = params.get('tab') === 'installed' ? 'installed' : 'discover';
    const appId = params.get('app') ?? '';
    const load = useCallback(
        () =>
            api<PluginList>('/plugins')
                .then(setData)
                .catch((error) => failed(error, latestT.current('plugins:load-failed'))),
        [],
    );
    useEffect(() => void load(), [load]);
    const act = async (path: string, method: string, body?: unknown) => {
        try {
            await api(path, method, body);
            await shell.refresh();
            await load();
        } catch (error) {
            failed(error, t('plugins:update-failed'));
            // What it asks for may have changed since this page loaded: show it as it is now.
            await load();
        }
    };
    /** The install screen's bindings (CB-451), while it is open. */
    const [binding, setBinding] = useState<{
        id: string;
        name: string;
        plan: PluginBindingPlan;
        acknowledged: string[];
    }>();
    /** Install, asking first which workspace datasets it uses when there is anything to ask (CB-451). */
    const install = async (plugin: CatalogRow) => {
        let plan: PluginBindingPlan;
        try {
            plan = await api<PluginBindingPlan>(`/plugins/${plugin.id}/bindings`);
        } catch (error) {
            failed(error, t('plugins.catalog:datasets-failed'));
            return;
        }
        // The sensitive scope the install page showed, acknowledged; the
        // server refuses it unacknowledged (the catalog may have changed).
        const acknowledged = plugin.openAnyHttps ? [OPEN_ANY_HTTPS_SCOPE] : [];
        if (bindingsNeedAsking(plan)) {
            setBinding({ id: plugin.id, name: plugin.name, plan, acknowledged });
            return;
        }
        await act(`/plugins/${plugin.id}/install`, 'POST', acknowledged.length ? { acknowledged } : {});
    };
    const installedById = new Map(data?.installed.map((row) => [row.id, row]));
    const catalogIds = new Set(data?.catalog.map((row) => row.id));
    const setTab = (next: string) => {
        const copy = new URLSearchParams(params);
        if (next === 'discover') {
            copy.delete('tab');
        } else {
            copy.set('tab', next);
        }
        copy.delete('app');
        setParams(copy, { replace: true });
    };
    const openApp = (id: string) => {
        const copy = new URLSearchParams(params);
        copy.set('app', id);
        setParams(copy);
    };
    const detail = data?.catalog.find((row) => row.id === appId);
    const needle = query.trim().toLowerCase();
    const visible = useMemo(() => {
        const rows = data?.catalog ?? [];
        return rows.filter((row) => {
            if (category) {
                const group = CATEGORIES.find((item) => item.id === category);
                if (group && !group.match(row)) {
                    return false;
                }
            }
            if (!needle) {
                return true;
            }
            return `${row.name} ${row.description} ${row.author}`.toLowerCase().includes(needle);
        });
    }, [data, category, needle]);

    return (
        <WorkspacePage
            slot="plugins-page"
            module={MODULE_IDS.plugins}
            title={t('plugins:title')}
            description={t('plugins.catalog:description')}
            actions={
                <div className="relative w-full max-w-xs">
                    <Search
                        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                        aria-hidden
                    />
                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t('plugins.catalog:search')}
                        aria-label={t('plugins.catalog:search')}
                        className="pl-8"
                    />
                </div>
            }
            bodyClassName="grid gap-8"
        >
            <Tabs value={tab} onValueChange={setTab}>
                <TabsList aria-label={t('plugins.catalog:tabs.label')}>
                    <TabsTrigger value="discover">{t('plugins.catalog:tabs.discover')}</TabsTrigger>
                    <TabsTrigger value="installed">{t('plugins.catalog:tabs.installed')}</TabsTrigger>
                </TabsList>
            </Tabs>
            {!data ? (
                <div className="grid gap-4" aria-busy="true" aria-label={t('plugins.catalog:loading')}>
                    <Skeleton className="h-40" />
                    <Skeleton className="h-40" />
                </div>
            ) : detail ? (
                <CatalogDetail
                    plugin={detail}
                    installed={installedById.get(detail.id)}
                    onBack={() => {
                        const copy = new URLSearchParams(params);
                        copy.delete('app');
                        setParams(copy);
                    }}
                    onInstall={() => void install(detail)}
                    onManage={() => void navigate(managePath(detail.id))}
                />
            ) : tab === 'installed' ? (
                <InstalledList
                    rows={data.installed.filter((row) =>
                        needle ? `${row.name} ${row.description}`.toLowerCase().includes(needle) : true,
                    )}
                    catalogIds={catalogIds}
                />
            ) : (
                <Discover
                    catalog={data.catalog}
                    visible={visible}
                    category={category}
                    onCategory={setCategory}
                    onOpen={openApp}
                />
            )}
            {binding && (
                <PluginInstallDialog
                    name={binding.name}
                    plan={binding.plan}
                    onClose={() => setBinding(undefined)}
                    onInstall={async (bindings) => {
                        await act(`/plugins/${binding.id}/install`, 'POST', {
                            bindings,
                            ...(binding.acknowledged.length ? { acknowledged: binding.acknowledged } : {}),
                        });
                        setBinding(undefined);
                    }}
                />
            )}
        </WorkspacePage>
    );
}

function Discover({
    catalog,
    visible,
    category,
    onCategory,
    onOpen,
}: {
    catalog: CatalogRow[];
    visible: CatalogRow[];
    category?: string;
    onCategory: (id?: string) => void;
    onOpen: (id: string) => void;
}) {
    const { t } = useTranslation(['plugins.catalog']);
    if (catalog.length === 0) {
        return (
            <CatalogEmpty
                title={t('plugins.catalog:empty-catalog.title')}
                body={t('plugins.catalog:empty-catalog.body')}
            />
        );
    }
    const popular = [...visible].sort((a, b) => Number(b.installed) - Number(a.installed));
    const recent = [...visible].reverse();
    return (
        <div className="grid gap-8">
            <section className="grid gap-3" aria-label={t('plugins.catalog:featured')}>
                <h2 className="text-sm font-medium">{t('plugins.catalog:featured')}</h2>
                <div className="grid gap-3 sm:grid-cols-3">
                    {CATEGORIES.map((item) => {
                        const count = catalog.filter((row) => item.match(row)).length;
                        const selected = category === item.id;
                        return (
                            <CategoryCard
                                key={item.id}
                                name={t(`plugins.catalog:categories.${item.id}`)}
                                detail={t('plugins.catalog:category-count', { count })}
                                icon={item.icon}
                                className={item.className}
                                selected={selected}
                                onClick={() => onCategory(selected ? undefined : item.id)}
                            />
                        );
                    })}
                </div>
            </section>
            <AppRow
                id="popular"
                title={t('plugins.catalog:popular')}
                rows={popular}
                onOpen={onOpen}
                slot="plugin-catalog"
            />
            <AppRow id="recent" title={t('plugins.catalog:recent')} rows={recent} onOpen={onOpen} />
        </div>
    );
}

function AppRow({
    id,
    title,
    rows,
    onOpen,
    slot,
}: {
    /** Which row, for its cards' keys. */
    id: string;
    title: string;
    rows: CatalogRow[];
    onOpen: (id: string) => void;
    slot?: string;
}) {
    const { t } = useTranslation(['plugins.catalog']);
    const labels = {
        installed: t('plugins.catalog:card.installed'),
        notInstalled: t('plugins.catalog:card.not-installed'),
        details: t('plugins.catalog:card.details'),
    };
    return (
        <section className="grid gap-3" data-slot={slot}>
            <h2 className="text-sm font-medium">{title}</h2>
            {rows.length === 0 ? (
                <CatalogEmpty
                    title={t('plugins.catalog:empty-view.title')}
                    body={t('plugins.catalog:empty-view.body')}
                />
            ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {rows.map((plugin) => (
                        <AppCard
                            key={`${id}-${plugin.id}`}
                            name={plugin.name}
                            author={plugin.author}
                            version={plugin.version}
                            description={plugin.description}
                            installed={plugin.installed}
                            icon={<PluginMark id={plugin.id} />}
                            onOpen={() => onOpen(plugin.id)}
                            labels={labels}
                        />
                    ))}
                </div>
            )}
        </section>
    );
}

function CatalogDetail({
    plugin,
    installed,
    onBack,
    onInstall,
    onManage,
}: {
    plugin: CatalogRow;
    installed?: InstalledRow;
    onBack: () => void;
    onInstall: () => void;
    onManage: () => void;
}) {
    const { t } = useTranslation(['plugins', 'plugins.catalog']);
    const words = usePluginWords();
    return (
        <AppDetail
            icon={<PluginMark id={plugin.id} large />}
            name={plugin.name}
            meta={t('plugins.catalog:detail.meta', {
                author: plugin.author,
                version: plugin.version,
                display: words.displayLabel(plugin.display, plugin.mode),
                mode: words.modeLabel(plugin.mode),
            })}
            description={plugin.description}
            installed={plugin.installed}
            onBack={onBack}
            onInstall={onInstall}
            onManage={onManage}
            labels={{
                back: t('plugins.catalog:detail.back'),
                manage: t('plugins.catalog:detail.manage'),
                install: t('plugins.catalog:detail.install'),
                screenshots: t('plugins.catalog:detail.screenshots'),
                permissions: t('plugins.catalog:detail.permissions'),
            }}
            screenshots={
                plugin.id === 'social-strategy' ? (
                    <div className="grid gap-3 md:grid-cols-2">
                        <ScreenshotFrame
                            title={t('plugins.catalog:screenshots.week.title')}
                            caption={t('plugins.catalog:screenshots.week.caption')}
                        >
                            <div className="grid h-36 grid-cols-7 gap-1">
                                {Array.from({ length: 7 }, (_, index) => (
                                    <div key={index} className="rounded bg-background/70 p-1">
                                        {index % 2 === 0 && <div className="mt-4 h-8 rounded bg-primary/30" />}
                                    </div>
                                ))}
                            </div>
                        </ScreenshotFrame>
                        <ScreenshotFrame
                            title={t('plugins.catalog:screenshots.composer.title')}
                            caption={t('plugins.catalog:screenshots.composer.caption')}
                        >
                            <div className="grid h-36 grid-cols-[1.2fr_0.8fr] gap-2">
                                <div className="rounded bg-background/80 p-2 text-[10px] text-muted-foreground">
                                    {t('plugins.catalog:screenshots.composer.draft')}
                                </div>
                                <div className="rounded-2xl border bg-background p-2 text-[10px] text-foreground">
                                    <div className="mb-1 flex items-center gap-1">
                                        <span className="size-4 rounded-full bg-sky-500" />
                                        <span className="font-semibold">
                                            {t('plugins.catalog:screenshots.composer.account')}
                                        </span>
                                    </div>
                                    {t('plugins.catalog:screenshots.composer.preview')}
                                </div>
                            </div>
                        </ScreenshotFrame>
                    </div>
                ) : undefined
            }
            permissions={
                <ul className="grid gap-1 text-sm text-muted-foreground">
                    {plugin.openAnyHttps && <OpenAnyHttpsScope as="li" />}
                    {plugin.storageWarnings?.length ? (
                        <li>
                            <StorageWarnings warnings={plugin.storageWarnings} />
                        </li>
                    ) : null}
                    {plugin.permissions.length === 0 && !plugin.openAnyHttps ? (
                        <li>{t('plugins:no-permissions')}</li>
                    ) : (
                        plugin.permissions.map((item) => (
                            <li key={item}>
                                <span className="font-medium text-foreground">{item}</span>
                                {' · '}
                                {words.permission(item)}
                            </li>
                        ))
                    )}
                </ul>
            }
            status={
                installed ? (
                    <p className="text-sm">
                        {t('plugins.catalog:detail.status', {
                            context: `${installed.enabled ? 'enabled' : 'disabled'}-${installed.mode === 'bundled' ? 'bundled' : 'service'}`,
                        })}
                    </p>
                ) : undefined
            }
        />
    );
}

/**
 * The Installed tab (CB-393): an overview, one row per installed plugin,
 * each linking to the plugin's own page, where its settings, who can use it
 * and Uninstall are.
 */
function InstalledList({ rows, catalogIds }: { rows: InstalledRow[]; catalogIds: Set<string> }) {
    const { t } = useTranslation(['plugins', 'plugins.catalog']);
    const words = usePluginWords();
    if (rows.length === 0) {
        return (
            <CatalogEmpty
                title={t('plugins.catalog:empty-installed.title')}
                body={t('plugins.catalog:empty-installed.body')}
            />
        );
    }
    return (
        <ul className="grid divide-y rounded-xl border bg-card text-card-foreground" data-slot="plugin-installed">
            {rows.map((plugin) => (
                <li key={plugin.id} className="flex flex-wrap items-center gap-3 p-4" data-slot="plugin-row">
                    <PluginMark id={plugin.id} />
                    <div className="grid min-w-0 flex-1 basis-56 gap-0.5">
                        <Link
                            to={managePath(plugin.id)}
                            className="flex flex-wrap items-center gap-2 font-medium hover:underline"
                            data-slot="plugin-manage-link"
                        >
                            {plugin.name}
                            <Badge variant={plugin.enabled ? 'default' : 'secondary'}>{words.runLabel(plugin)}</Badge>
                            {plugin.update && (
                                <Badge variant="outline">
                                    {t('plugins:update-to', { version: plugin.update.version })}
                                </Badge>
                            )}
                            <BackupBadge backup={plugin.backup} />
                        </Link>
                        <p className="line-clamp-2 text-sm text-muted-foreground">{plugin.description}</p>
                        <p className="text-xs text-muted-foreground">
                            {t('plugins:meta', {
                                author: plugin.author,
                                version: plugin.version,
                                context: catalogIds.has(plugin.id) ? undefined : 'removed',
                            })}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {plugin.enabled && <OpenPlugin plugin={plugin} variant="outline" />}
                        <Link
                            to={managePath(plugin.id)}
                            aria-label={t('plugins.catalog:manage-label', { name: plugin.name })}
                            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-accent"
                        >
                            {t('plugins.catalog:manage')}
                            <ChevronRight className="size-4" aria-hidden="true" />
                        </Link>
                    </div>
                </li>
            ))}
        </ul>
    );
}
