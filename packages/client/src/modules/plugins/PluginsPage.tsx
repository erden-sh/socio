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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { AppCard, AppDetail, CatalogEmpty, CategoryCard, ScreenshotFrame } from '@socio/plugin-ui';
import { MODULE_IDS } from '@socio/shared/modules';
import type { PluginBindingPlan } from '@socio/shared/plugins/bindings';
import { OPEN_ANY_HTTPS_SCOPE } from '@socio/shared/plugins/plugins';

import { api } from '../../lib/api';
import { useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';

import {
    BackupBadge,
    displayLabel,
    failed,
    managePath,
    modeLabel,
    OpenAnyHttpsScope,
    OpenPlugin,
    PERMISSIONS,
    PluginMark,
    runLabel,
    StorageWarnings,
    type CatalogRow,
    type InstalledRow,
    type PluginList,
} from './plugin-rows';
import { bindingsNeedAsking, PluginInstallDialog } from './PluginDatasetBindings';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const CATEGORIES: {
    id: string;
    name: string;
    blurb: string;
    className: string;
    icon: typeof CalendarDays;
    match: (plugin: CatalogRow) => boolean;
}[] = [
    {
        id: 'scheduling',
        name: 'Scheduling',
        blurb: 'Calendars and queues',
        className: 'from-emerald-900 via-teal-800 to-slate-900',
        icon: CalendarDays,
        match: (plugin) =>
            plugin.permissions.some((item) => item.startsWith('social') || item.startsWith('calendar')) ||
            plugin.id === 'social-strategy' ||
            plugin.id === 'calendar',
    },
    {
        id: 'publishing',
        name: 'Publishing',
        blurb: 'Where a draft goes next',
        className: 'from-indigo-900 via-blue-800 to-slate-900',
        icon: Send,
        match: () => false,
    },
    {
        id: 'analytics',
        name: 'Analytics',
        blurb: 'What the plan did',
        className: 'from-rose-900 via-orange-800 to-slate-900',
        icon: BarChart3,
        match: () => false,
    },
];

/**
 * `/plugins`: this instance's catalog and the services an admin has
 * installed. The catalog is empty until `PLUGIN_CATALOGS` names something.
 */
export function PluginsPage() {
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
                .catch((error) => failed(error, 'Could not load plugins.')),
        [],
    );
    useEffect(() => void load(), [load]);
    const act = async (path: string, method: string, body?: unknown) => {
        try {
            await api(path, method, body);
            await shell.refresh();
            await load();
        } catch (error) {
            failed(error, 'Could not update the plugin.');
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
            failed(error, 'Could not load the plugin’s datasets.');
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
            title="Plugins"
            description="Features installed on this instance. Some run inside Socio, others as their own service. Nothing is installed until you install it."
            actions={
                <div className="relative w-full max-w-xs">
                    <Search
                        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                        aria-hidden
                    />
                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search plugins"
                        aria-label="Search plugins"
                        className="pl-8"
                    />
                </div>
            }
            bodyClassName="grid gap-8"
        >
            <Tabs value={tab} onValueChange={setTab}>
                <TabsList aria-label="Plugin sections">
                    <TabsTrigger value="discover">Discover</TabsTrigger>
                    <TabsTrigger value="installed">Installed</TabsTrigger>
                </TabsList>
            </Tabs>
            {!data ? (
                <div className="grid gap-4" aria-busy="true" aria-label="Loading plugins">
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
    if (catalog.length === 0) {
        return (
            <CatalogEmpty
                title="No plugins in the catalog"
                body="This instance offers no plugins. Whoever operates the server lists them in PLUGIN_CATALOGS."
            />
        );
    }
    const popular = [...visible].sort((a, b) => Number(b.installed) - Number(a.installed));
    const recent = [...visible].reverse();
    return (
        <div className="grid gap-8">
            <section className="grid gap-3" aria-label="Featured categories">
                <h2 className="text-sm font-medium">Featured categories</h2>
                <div className="grid gap-3 sm:grid-cols-3">
                    {CATEGORIES.map((item) => {
                        const count = catalog.filter((row) => item.match(row)).length;
                        const selected = category === item.id;
                        return (
                            <CategoryCard
                                key={item.id}
                                name={item.name}
                                detail={`${count} ${count === 1 ? 'app' : 'apps'}`}
                                icon={item.icon}
                                className={item.className}
                                selected={selected}
                                onClick={() => onCategory(selected ? undefined : item.id)}
                            />
                        );
                    })}
                </div>
            </section>
            <AppRow title="Popular" rows={popular} onOpen={onOpen} slot="plugin-catalog" />
            <AppRow title="Recently added" rows={recent} onOpen={onOpen} />
        </div>
    );
}

function AppRow({
    title,
    rows,
    onOpen,
    slot,
}: {
    title: string;
    rows: CatalogRow[];
    onOpen: (id: string) => void;
    slot?: string;
}) {
    return (
        <section className="grid gap-3" data-slot={slot}>
            <h2 className="text-sm font-medium">{title}</h2>
            {rows.length === 0 ? (
                <CatalogEmpty title="No apps in this view" body="Clear the search or pick another category." />
            ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {rows.map((plugin) => (
                        <AppCard
                            key={`${title}-${plugin.id}`}
                            name={plugin.name}
                            author={plugin.author}
                            version={plugin.version}
                            description={plugin.description}
                            installed={plugin.installed}
                            icon={<PluginMark id={plugin.id} />}
                            onOpen={() => onOpen(plugin.id)}
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
    return (
        <AppDetail
            icon={<PluginMark id={plugin.id} large />}
            name={plugin.name}
            meta={`${plugin.author} · ${plugin.version} · ${displayLabel(plugin.display, plugin.mode)} · ${modeLabel(plugin.mode)}`}
            description={plugin.description}
            installed={plugin.installed}
            onBack={onBack}
            onInstall={onInstall}
            onManage={onManage}
            screenshots={
                plugin.id === 'social-strategy' ? (
                    <div className="grid gap-3 md:grid-cols-2">
                        <ScreenshotFrame title="Week" caption="Posts sit on a time grid.">
                            <div className="grid h-36 grid-cols-7 gap-1">
                                {Array.from({ length: 7 }, (_, index) => (
                                    <div key={index} className="rounded bg-background/70 p-1">
                                        {index % 2 === 0 && <div className="mt-4 h-8 rounded bg-primary/30" />}
                                    </div>
                                ))}
                            </div>
                        </ScreenshotFrame>
                        <ScreenshotFrame title="Composer" caption="A draft on the left, the X card on the right.">
                            <div className="grid h-36 grid-cols-[1.2fr_0.8fr] gap-2">
                                <div className="rounded bg-background/80 p-2 text-[10px] text-muted-foreground">
                                    Write something…
                                </div>
                                <div className="rounded-2xl border bg-background p-2 text-[10px] text-foreground">
                                    <div className="mb-1 flex items-center gap-1">
                                        <span className="size-4 rounded-full bg-sky-500" />
                                        <span className="font-semibold">account</span>
                                    </div>
                                    Your post shows up here.
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
                        <li>Asks for no extra permissions.</li>
                    ) : (
                        plugin.permissions.map((item) => (
                            <li key={item}>
                                <span className="font-medium text-foreground">{item}</span>
                                {' · '}
                                {PERMISSIONS[item] ?? item}
                            </li>
                        ))
                    )}
                </ul>
            }
            status={
                installed ? (
                    <p className="text-sm">
                        {installed.enabled ? 'Enabled' : 'Disabled'} on this instance.{' '}
                        {installed.mode === 'bundled'
                            ? 'Choose who can use it and open it from Installed.'
                            : 'Open it and change its settings from its page.'}
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
    if (rows.length === 0) {
        return (
            <CatalogEmpty
                title="No plugin is installed"
                body="Install one from the catalog on this instance. It stays off everywhere else."
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
                            <Badge variant={plugin.enabled ? 'default' : 'secondary'}>{runLabel(plugin)}</Badge>
                            {plugin.update && <Badge variant="outline">Update to {plugin.update.version}</Badge>}
                            <BackupBadge backup={plugin.backup} />
                        </Link>
                        <p className="line-clamp-2 text-sm text-muted-foreground">{plugin.description}</p>
                        <p className="text-xs text-muted-foreground">
                            {plugin.author} · {plugin.version}
                            {catalogIds.has(plugin.id) ? '' : ' · no longer in the catalog'}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {plugin.enabled && <OpenPlugin plugin={plugin} variant="outline" />}
                        <Link
                            to={managePath(plugin.id)}
                            aria-label={`Manage ${plugin.name}`}
                            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-accent"
                        >
                            Manage
                            <ChevronRight className="size-4" aria-hidden="true" />
                        </Link>
                    </div>
                </li>
            ))}
        </ul>
    );
}
