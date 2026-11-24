import type { UnitOfWork } from '@socio/data/uow';
import {
    compareComponents,
    COMPONENT_WILDCARDS,
    ISSUE_COMPONENTS_MAX,
    parseComponentRef,
    WILDCARD_LABELS,
    type ComponentWildcard,
    type IssueComponentLabel,
    type IssueComponentOption,
} from '@socio/shared/issues/issue-components';
import type { IssueEvent, IssueEventKind } from '@socio/shared/issues/issue-types';

import {
    IssueError,
    type BoardComponents,
    type ComponentApp,
    type ComponentPlugin,
    type ComponentView,
    type IssueComponentSourcesShape,
} from './contract.js';
import type { ComponentRepository, ComponentRow } from './domain/repositories.js';

/**
 * Issue components (CB-442): the
 * plugins and apps an issue is about, and who may see each tag.
 *
 * A stored ref is canonical: `plugins:*`, `apps:*`, `plugin:<id>`, or
 * `app:<id>@<createdAt>`, so a tag never moves to a later app that takes a
 * deleted app's address. A reader sees `app:<id>` while that very app is
 * live, and `app:<id>@<createdAt>` once it is gone.
 *
 * Who sees a tag: the wildcards, everyone; an installed plugin, whoever may
 * use it, and admins even when it is off; an uninstalled one, by the
 * audience it had; a live app, its owner and the readers of the Space it is
 * shared with, and admins, who see every app's name and owner; a deleted
 * app, admins and its last owner. A hidden tag is left out entirely,
 * everywhere: lists, the detail, history, proposals.
 */

/** Unknown, or hidden from this reader: the same answer, so it can't probe. */
const unknown = (ref: string) => new IssueError(`Unknown component: ${ref.slice(0, 80)}.`);

interface Resolved {
    key: string;
    label: IssueComponentLabel;
}

/** One reader's view of the workspace's plugins and apps, read once. */
class Lens {
    readonly admin: boolean;
    private plugins: Map<string, ComponentPlugin>;
    private apps: Map<string, ComponentApp>;
    private names = new Map<string, string | undefined>();

    constructor(
        private sources: IssueComponentSourcesShape | undefined,
        readonly viewerId: string,
    ) {
        this.admin = !!sources?.isAdmin(viewerId);
        this.plugins = new Map((sources?.plugins() ?? []).map((plugin) => [plugin.id, plugin]));
        this.apps = new Map((sources?.apps() ?? []).map((app) => [app.id, app]));
    }

    private ownerName(userId: string) {
        if (!this.names.has(userId)) {
            this.names.set(userId, this.sources?.userName(userId));
        }
        return this.names.get(userId) ?? 'Another user';
    }

    private mayUse(plugin: ComponentPlugin) {
        return this.admin || !!this.sources?.mayUsePlugin(plugin.id, this.viewerId);
    }

    private mayOpen(app: ComponentApp) {
        return this.admin || !!this.sources?.mayOpenApp(app.id, this.viewerId);
    }

    /** What this reader may pick. */
    options(): IssueComponentOption[] {
        const options: IssueComponentOption[] = COMPONENT_WILDCARDS.map((ref) => ({
            ref,
            label: WILDCARD_LABELS[ref],
            kind: ref === 'plugins:*' ? 'plugins' : 'apps',
        }));
        for (const plugin of this.plugins.values()) {
            if (this.mayUse(plugin)) {
                options.push({
                    ref: `plugin:${plugin.id}`,
                    label: plugin.name,
                    kind: 'plugin',
                    ...(this.admin ? { state: plugin.enabled ? 'live' : 'disabled' } : {}),
                });
            }
        }
        for (const app of this.apps.values()) {
            if (this.mayOpen(app)) {
                options.push({
                    ref: `app:${app.id}`,
                    label: app.name,
                    kind: 'app',
                    ownerName: this.ownerName(app.ownerUserId),
                });
            }
        }
        return options.sort(compareComponents);
    }

    /** A ref this reader typed, as stored: a live app's gets its generation. */
    canonical(ref: string) {
        const parsed = parseComponentRef(ref);
        if (!parsed) {
            return undefined;
        }
        if (parsed.kind === 'app' && parsed.generation === null) {
            const app = this.apps.get(parsed.id!);
            return app ? `app:${app.id}@${app.createdAt}` : undefined;
        }
        return ref;
    }

    /**
     * How a stored ref reads for this reader, or undefined when it is
     * hidden. `row` is the tag, when there is one: its name and audience
     * then; a history row or a proposal may name a ref no tag has.
     */
    resolve(ref: string, row?: Pick<ComponentRow, 'label' | 'audience'>): Resolved | undefined {
        const parsed = parseComponentRef(ref);
        if (!parsed) {
            return undefined;
        }
        if (parsed.kind === 'plugins' || parsed.kind === 'apps') {
            return {
                key: ref,
                label: { label: WILDCARD_LABELS[ref as ComponentWildcard], kind: parsed.kind, state: 'live' },
            };
        }
        if (parsed.kind === 'plugin') {
            const plugin = this.plugins.get(parsed.id!);
            if (plugin) {
                return this.mayUse(plugin)
                    ? {
                          key: ref,
                          label: { label: plugin.name, kind: 'plugin', state: plugin.enabled ? 'live' : 'disabled' },
                      }
                    : undefined;
            }
            // Uninstalled: whoever its audience was, from the tag; admins always.
            if (!this.admin && row?.audience !== 'members') {
                return undefined;
            }
            return { key: ref, label: { label: row?.label ?? parsed.id!, kind: 'plugin', state: 'uninstalled' } };
        }
        if (parsed.generation === null) {
            return undefined;
        }
        const app = this.apps.get(parsed.id!);
        if (app && app.createdAt === parsed.generation) {
            return this.mayOpen(app)
                ? {
                      key: `app:${app.id}`,
                      label: {
                          label: app.name,
                          kind: 'app',
                          state: 'live',
                          ownerName: this.ownerName(app.ownerUserId),
                      },
                  }
                : undefined;
        }
        // Deleted, or its address taken by a later app: admins and its last owner.
        const retired = this.sources?.retiredApp(parsed.id!, parsed.generation);
        if (!this.admin && (!retired || retired.ownerUserId !== this.viewerId)) {
            return undefined;
        }
        return {
            key: ref,
            label: {
                label: row?.label ?? retired?.name ?? parsed.id!,
                kind: 'app',
                state: 'deleted',
                ...(retired ? { ownerName: this.ownerName(retired.ownerUserId) } : {}),
            },
        };
    }

    /** A new tag for an option, with the name it has now. */
    row(issueId: string, ref: string, addedBy: string, addedAt: number): ComponentRow | undefined {
        const parsed = parseComponentRef(ref);
        if (!parsed) {
            return undefined;
        }
        const base = { issueId, addedBy, addedAt, generation: null, audience: null } as const;
        if (parsed.kind === 'plugins' || parsed.kind === 'apps') {
            return {
                ...base,
                ref,
                kind: parsed.kind,
                targetId: null,
                label: WILDCARD_LABELS[ref as ComponentWildcard],
            };
        }
        if (parsed.kind === 'plugin') {
            const plugin = this.plugins.get(parsed.id!);
            return plugin
                ? {
                      ...base,
                      ref,
                      kind: 'plugin',
                      targetId: plugin.id,
                      label: plugin.name,
                      audience: plugin.audience,
                  }
                : undefined;
        }
        const app = this.apps.get(parsed.id!);
        return app && app.createdAt === parsed.generation
            ? {
                  ...base,
                  ref,
                  kind: 'app',
                  targetId: app.id,
                  generation: app.createdAt,
                  label: app.name,
              }
            : undefined;
    }

    /** A tag's name now, while its target is live. */
    liveLabel(row: ComponentRow) {
        const fresh = this.row(row.issueId, row.ref, row.addedBy, row.addedAt);
        return fresh ? { ...row, label: fresh.label, audience: fresh.audience ?? row.audience } : row;
    }
}

const sortRefs = (refs: Iterable<string>) => [...new Set(refs)].sort();
const asJson = (refs: readonly string[]) => (refs.length ? JSON.stringify(sortRefs(refs)) : null);
function refsOf(value: string | null): string[] {
    if (!value) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === 'string') : [];
    } catch {
        return [];
    }
}

/** The Board's components service (`BoardComponents`). */
export class IssueComponents implements BoardComponents {
    private sources?: IssueComponentSourcesShape;

    constructor(
        private uow: UnitOfWork,
        private repo: ComponentRepository,
        private history: {
            record(
                issueId: string,
                actorId: string | null,
                kind: IssueEventKind,
                fromValue: string | null,
                toValue: string | null,
                now?: number,
            ): Promise<unknown>;
            touch(issueId: string, now: number): Promise<void>;
        },
    ) {}

    /**
     * Binds the plugins, apps and people (the composition, once they are
     * built). Until then only the two wildcards exist.
     */
    useSources(sources: IssueComponentSourcesShape) {
        this.sources = sources;
    }

    private lens(userId: string) {
        return new Lens(this.sources, userId);
    }

    options(userId: string) {
        return this.lens(userId).options();
    }

    /**
     * Every option there is, whoever asks: wildcards, installed plugins and
     * live apps, for automatic triage's model. Never shown to a person as
     * is.
     */
    everyOption(): IssueComponentOption[] {
        const lens = new Lens(this.sources && { ...this.sources, isAdmin: () => true }, '');
        return lens.options().map(({ ref, label, kind }) => ({ ref, label, kind }));
    }

    isAdmin(userId: string) {
        return !!userId && !!this.sources?.isAdmin(userId);
    }

    /** A ref from `everyOption`, as stored (an app's with its generation). */
    canonical(ref: string) {
        return this.lens('').canonical(ref);
    }

    async view(userId: string, issueIds?: readonly string[]): Promise<ComponentView> {
        const lens = this.lens(userId);
        const rows = issueIds && issueIds.length === 1 ? await this.repo.forIssue(issueIds[0]!) : await this.repo.all();
        const wanted = issueIds && new Set(issueIds);
        const byIssue = new Map<string, string[]>();
        const labels: Record<string, IssueComponentLabel> = {};
        for (const row of rows) {
            if (wanted && !wanted.has(row.issueId)) {
                continue;
            }
            const seen = lens.resolve(row.ref, row);
            if (!seen) {
                continue;
            }
            labels[seen.key] = seen.label;
            byIssue.set(row.issueId, [...(byIssue.get(row.issueId) ?? []), seen.key]);
        }
        for (const [issueId, keys] of byIssue) {
            byIssue.set(issueId, sortRefs(keys));
        }
        return { byIssue, labels };
    }

    async checkFilter(userId: string, ref: string) {
        const lens = this.lens(userId);
        if (lens.options().some((option) => option.ref === ref)) {
            return;
        }
        // A tag the reader sees on an issue, though no longer an option
        // (an uninstalled plugin, a deleted app).
        const stored = lens.canonical(ref);
        if (stored && (await this.repo.all()).some((row) => row.ref === stored && lens.resolve(row.ref, row))) {
            return;
        }
        throw unknown(ref);
    }

    set(
        issueId: string,
        refs: readonly string[],
        {
            actorId,
            viewerId,
            now = Date.now(),
            initial = false,
        }: { actorId: string; viewerId: string; now?: number; initial?: boolean },
    ) {
        return this.uow.run(
            async () => {
                const lens = this.lens(viewerId);
                const current = await this.repo.forIssue(issueId);
                const shown = new Map<string, ComponentRow>();
                const kept: ComponentRow[] = [];
                for (const row of current) {
                    const seen = lens.resolve(row.ref, row);
                    if (seen) {
                        shown.set(seen.key, row);
                    } else {
                        // Hidden from this editor: it stays.
                        kept.push(row);
                    }
                }
                const options = new Set(lens.options().map((option) => option.ref));
                const next = [...kept];
                for (const ref of new Set(refs)) {
                    const existing = shown.get(ref);
                    if (existing) {
                        next.push(lens.liveLabel(existing));
                        continue;
                    }
                    const stored = options.has(ref) ? lens.canonical(ref) : undefined;
                    const row = stored && lens.row(issueId, stored, actorId, now);
                    if (!row) {
                        throw unknown(ref);
                    }
                    if (!next.some((one) => one.ref === row.ref)) {
                        next.push(row);
                    }
                }
                if (next.length > ISSUE_COMPONENTS_MAX) {
                    throw new IssueError(`An issue can have at most ${ISSUE_COMPONENTS_MAX} components.`);
                }
                const before = sortRefs(current.map((row) => row.ref));
                const after = sortRefs(next.map((row) => row.ref));
                if (before.join('\n') === after.join('\n')) {
                    return false;
                }
                await this.repo.replace(
                    issueId,
                    next.sort((a, b) => a.ref.localeCompare(b.ref)),
                );
                if (!initial) {
                    await this.history.record(issueId, actorId, 'components', asJson(before), asJson(after), now);
                    await this.history.touch(issueId, now);
                }
                return true;
            },
            { label: 'set issue components' },
        );
    }

    prefill({
        personId,
        socioId,
        conversationId,
    }: {
        personId: string;
        socioId: string;
        conversationId: string | null;
    }): string[] {
        if (!conversationId || !this.sources) {
            return [];
        }
        const options = new Set(this.options(personId).map((option) => option.ref));
        const found = new Set(
            this.sources
                .conversationAudiences({ personId, socioId, conversationId })
                .filter((audience) => /^(?:app|plugin):/.test(audience) && options.has(audience)),
        );
        return found.size === 1 ? [...found] : [];
    }

    /**
     * Refs a reader may see out of stored ones (a proposal's), with how
     * each reads; `rows` are the issue's tags, for their names and audiences.
     */
    visibleRefs(
        userId: string,
        refs: readonly string[],
        rows: ReadonlyArray<Pick<ComponentRow, 'ref' | 'label' | 'audience'>> = [],
    ) {
        const lens = this.lens(userId);
        const byRef = new Map(rows.map((row) => [row.ref, row]));
        const keys: string[] = [];
        const labels: Record<string, IssueComponentLabel> = {};
        for (const ref of refs) {
            const seen = lens.resolve(ref, byRef.get(ref));
            if (seen) {
                keys.push(seen.key);
                labels[seen.key] = seen.label;
            }
        }
        return { keys: sortRefs(keys), labels };
    }

    /**
     * History as a reader may see it: a `components` row keeps only the refs
     * they may see, and goes when no visible change is left.
     */
    async visibleEvents(userId: string, issueId: string, events: readonly IssueEvent[]) {
        if (!events.some((event) => event.kind === 'components')) {
            return { events: [...events], labels: {} as Record<string, IssueComponentLabel> };
        }
        // Names as last tagged, so a removed tag or an uninstalled plugin's
        // history reads as it did; a current tag's own name wins.
        const rows = [...(await this.repo.names(issueId)), ...(await this.repo.forIssue(issueId))];
        const labels: Record<string, IssueComponentLabel> = {};
        const out: IssueEvent[] = [];
        for (const event of events) {
            if (event.kind !== 'components') {
                out.push(event);
                continue;
            }
            const from = this.visibleRefs(userId, refsOf(event.fromValue), rows);
            const to = this.visibleRefs(userId, refsOf(event.toValue), rows);
            if (from.keys.join('\n') === to.keys.join('\n')) {
                continue;
            }
            Object.assign(labels, from.labels, to.labels);
            out.push({ ...event, fromValue: asJson(from.keys), toValue: asJson(to.keys) });
        }
        return { events: out, labels };
    }

    /** One issue's stored tags (triage's apply, the views). */
    rowsOf(issueId: string) {
        return this.repo.forIssue(issueId);
    }
}
