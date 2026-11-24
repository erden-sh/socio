import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';

import { LEARNING_LABEL_NAMES, MIN_GOLDEN, type LearningLabel } from '@socio/shared/classify';
import {
    PROPOSAL_PAGE,
    PROPOSAL_PAGE_MAX,
    droppedWhy,
    type LearningContainerDetail as ContainerDetail,
    type LearningContainerSummary as ContainerSummary,
    type LearningProposalPage,
    type LearningProposalView,
    type PublishedSkills,
    type LearningRunView,
    type LearningSeamView,
    type LearningSocioSettings,
    type LearningTriageView,
} from '@socio/shared/learning';
import { formatNumber } from '@socio/shared/locale';
import { intentName } from '@socio/shared/operations/operations-themes';

import { api, apiIfChanged, PollTags, UNCHANGED } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { useIsAdmin } from '../../shell/current-user';
import { useFlag } from '../../shell/flags';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** What the Learning page's loader brings: the first screen's data. */
export type LearningSeed =
    | { admin: false; skills: PublishedSkills }
    | {
          admin: true;
          containers: ContainerSummary[];
          open: ContainerDetail | null;
      };

interface Proposal {
    id: string;
    name: string;
    description: string;
    skillMd: string;
    rationale: string;
    evidenceThreadIds: string[];
    status: 'pending' | 'published' | 'rejected';
    createdAt: number;
}
interface ProposalDetail {
    proposal: Proposal;
    evidence: Array<{
        threadId: string;
        title: string;
        ownerId: string | null;
        /** Its triage on the classification seam (CB-200), when it had one. */
        triage?: {
            label: LearningLabel | null;
            source: 'admin' | 'model' | null;
            score: number | null;
            intent: string | null;
        } | null;
        messages: Array<{ role: string; content: string }>;
    }>;
    current: { revision: number; description: string; skillMd: string } | null;
}

/** Proposals the user loaded past the first page, and the next page's cursor. */
interface OlderProposals {
    items: LearningProposalView[];
    cursor?: string;
}

const proposalsPage = (id: string, cursor: string, limit = PROPOSAL_PAGE) =>
    api<LearningProposalPage>(
        `/learning/containers/${id}/proposals?bodies=false&limit=${limit}&cursor=${encodeURIComponent(cursor)}`,
    );

/** True when `a` is `b` or comes after it in the list (newest first). */
const atOrAfter = (a: LearningProposalView, b: LearningProposalView) =>
    a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id <= b.id);

/**
 * The pages after a fresh first page, read again down to the oldest
 * proposal the user had loaded (or the end), so a poll keeps them fresh
 * without dropping any: new proposals push older ones down, not out.
 * `shown` is what the list showed before, first page included; each read
 * asks for as many as were shown after where the last one ended.
 */
export async function refreshOlder(
    first: LearningProposalView[],
    cursor: string | undefined,
    shown: LearningProposalView[],
    page: (cursor: string, limit: number) => Promise<LearningProposalPage>,
): Promise<OlderProposals> {
    const oldest = shown.at(-1);
    const items: LearningProposalView[] = [];
    while (cursor && oldest) {
        const last = items.at(-1) ?? first.at(-1);
        if (last && atOrAfter(last, oldest)) {
            break;
        }
        const index = last ? shown.findIndex((p) => p.id === last.id) : -1;
        const want = index >= 0 ? shown.length - index - 1 : PROPOSAL_PAGE;
        const next = await page(cursor, Math.min(PROPOSAL_PAGE_MAX, want));
        items.push(...next.items);
        cursor = next.nextCursor;
    }
    return { items, cursor };
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * A run's status line: " Last run: succeeded (manual), 2 proposals, 1
 * dropped (…), 3 conversations left out by triage, 12,000 tokens, $0.0100."
 */
export function runLine(run: LearningRunView) {
    const parts = [`${run.proposals} proposal${run.proposals === 1 ? '' : 's'}`];
    if (run.dropped) {
        parts.push(`${run.dropped} dropped${droppedWhy(run.dropReasons)}`);
    }
    if (run.skipped) {
        parts.push(`${run.skipped} conversation${run.skipped === 1 ? '' : 's'} left out by triage`);
    }
    // Runs from before CB-200, and models that don't say, have none.
    const reported = (value: number | null | undefined) => (typeof value === 'number' ? value : undefined);
    const input = reported(run.inputTokens);
    const output = reported(run.outputTokens);
    if (input !== undefined || output !== undefined) {
        parts.push(`${formatNumber((input ?? 0) + (output ?? 0))} tokens`);
    }
    const cost = reported(run.costUsd);
    if (cost !== undefined) {
        parts.push(`$${cost.toFixed(4)}`);
    }
    return ` Last run: ${run.status} (${run.trigger}), ${parts.join(', ')}.`;
}

/** A conversation's triage in a few words: "82% repeatable · intent Write". */
export function triageLine(triage: {
    label: LearningLabel | null;
    source: 'admin' | 'model' | null;
    score: number | null;
    intent: string | null;
}) {
    const parts: string[] = [];
    if (triage.label) {
        parts.push(`${LEARNING_LABEL_NAMES[triage.label]}${triage.source === 'admin' ? ' (admin)' : ''}`);
    }
    if (triage.score !== null) {
        parts.push(`model: ${percent(triage.score)} repeatable`);
    }
    if (triage.intent) {
        parts.push(`intent: ${intentName(triage.intent)}`);
    }
    return parts.join(' · ');
}

/** Line diff (LCS) between the published SKILL.md and a proposal. */
export function lineDiff(before: string, after: string) {
    const a = before ? before.split('\n') : [];
    const b = after.split('\n');
    const table = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const out: Array<{ kind: ' ' | '+' | '-'; text: string }> = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            out.push({ kind: ' ', text: a[i] });
            i++;
            j++;
        } else if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j])) {
            out.push({ kind: '+', text: b[j++] });
        } else {
            out.push({ kind: '-', text: a[i++] });
        }
    }
    return out;
}

/** The view's type, in the scale the rest of the app's pages use. */
const HEADING = 'mb-1 text-[21px] font-[550] tracking-[-0.04em]';
const SECTION = 'mt-5.5 mb-2 text-[13px] font-[550] tracking-[-0.04em]';
const MUTED = 'text-xs leading-relaxed text-muted-foreground';
const LIST = 'flex flex-col gap-2.5';
const ITEM = 'rounded-[10px] border px-3 py-2.5';
const ITEM_TEXT = 'my-1 text-xs leading-relaxed';

function FieldLabel(props: ComponentProps<'label'>) {
    return <label className="mt-4 mb-1 block text-[11px] font-medium text-muted-foreground" {...props} />;
}

/** Scope creation and edits reuse each socio's Learning assignment. */
export function ScopeSettings({ onSaved }: { onSaved: () => void | Promise<void> }) {
    const [dots, setDots] = useState<LearningSocioSettings[]>();
    const [draft, setDraft] = useState<LearningSocioSettings>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState(false);
    const load = async () => {
        setError('');
        try {
            const next = await api<LearningSocioSettings[]>('/learning/settings');
            setDots(next);
            setDraft(next[0]);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not load scopes.');
        }
    };
    return (
        <section className="col-span-full min-w-0">
            <Button variant="outline" aria-expanded={!!dots} onClick={() => (dots ? setDots(undefined) : void load())}>
                Manage scopes
            </Button>
            {error && <ErrorNote>{error}</ErrorNote>}
            {dots && (
                <form
                    className="mt-3 max-w-xl rounded-lg border p-4"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (!draft || busy) {
                            return;
                        }
                        setBusy(true);
                        setError('');
                        setSaved(false);
                        try {
                            const next = await api<LearningSocioSettings>(
                                `/learning/settings/${encodeURIComponent(draft.id)}`,
                                'PATCH',
                                {
                                    learningContainerId: draft.learningContainerId?.trim() || null,
                                    skillDeliveryEnabled: draft.skillDeliveryEnabled,
                                },
                            );
                            setDraft(next);
                            setDots(dots.map((dot) => (dot.id === next.id ? next : dot)));
                            setSaved(true);
                            await onSaved();
                        } catch (cause) {
                            setError(cause instanceof Error ? cause.message : 'Could not save scope.');
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    <h2 className={HEADING}>Learning scopes</h2>
                    <p className={MUTED}>
                        Assign a socio to a new or existing scope. Changes apply to new conversations; existing evidence
                        and published skills stay in their original scope.
                    </p>
                    {draft ? (
                        <fieldset disabled={busy}>
                            <FieldLabel htmlFor="learning-scope-socio">Socio</FieldLabel>
                            <select
                                id="learning-scope-socio"
                                className="w-full rounded-md border bg-background p-2 text-sm"
                                value={draft.id}
                                onChange={(event) => {
                                    setDraft(dots.find((dot) => dot.id === event.target.value));
                                    setSaved(false);
                                }}
                            >
                                {dots.map((dot) => (
                                    <option key={dot.id} value={dot.id}>
                                        {dot.name}
                                    </option>
                                ))}
                            </select>
                            <FieldLabel htmlFor="learning-scope-id">Scope ID</FieldLabel>
                            <Input
                                id="learning-scope-id"
                                maxLength={64}
                                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                                placeholder="research-workflow"
                                value={draft.learningContainerId ?? ''}
                                onChange={(event) => {
                                    const id = event.target.value;
                                    setDraft({
                                        ...draft,
                                        learningContainerId: id,
                                        skillDeliveryEnabled: !!id.trim() && draft.skillDeliveryEnabled,
                                    });
                                    setSaved(false);
                                }}
                            />
                            <p className={MUTED}>
                                Use lowercase letters, numbers and hyphens. Leave blank to stop collecting new evidence
                                for this socio.
                            </p>
                            <label className="my-3 flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    checked={draft.skillDeliveryEnabled}
                                    disabled={!draft.learningContainerId?.trim()}
                                    onChange={(event) => {
                                        setDraft({
                                            ...draft,
                                            skillDeliveryEnabled: event.target.checked,
                                        });
                                        setSaved(false);
                                    }}
                                />
                                Use this scope’s published skills
                            </label>
                            <Button type="submit" disabled={busy}>
                                {busy ? 'Saving…' : 'Save scope'}
                            </Button>
                            {saved && (
                                <p role="status" className={MUTED}>
                                    Scope saved. Start new conversations to collect evidence.
                                </p>
                            )}
                        </fieldset>
                    ) : (
                        <p className={MUTED}>Create a socio first, then assign its Learning scope here.</p>
                    )}
                </form>
            )}
        </section>
    );
}

function PublishedSkillList({ initial }: { initial?: PublishedSkills }) {
    const [containers, setContainers] = useState<PublishedSkills | undefined>(initial);
    const seeded = useRef(!!initial);
    useEffect(() => {
        if (seeded.current) {
            seeded.current = false;
            return;
        }
        void api<PublishedSkills>('/learning/skills').then(setContainers);
    }, []);
    const all = containers?.flatMap((c) => c.skills.map((skill) => ({ ...skill, containerId: c.containerId })));
    return (
        <section data-slot="learning-skills">
            <h2 className={HEADING}>Published skills</h2>
            <p className={MUTED}>Reviewed procedures your socios can load. Admins choose what is published.</p>
            {all?.length ? (
                <ul className={cn(LIST, 'mt-3')}>
                    {all.map((skill) => (
                        <li key={`${skill.containerId}/${skill.name}`} data-slot="learning-skill" className={ITEM}>
                            <strong>{skill.name}</strong> <small className="text-xs">{skill.containerId}</small>
                            <p className={ITEM_TEXT}>{skill.description}</p>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className={MUTED}>{containers ? 'No skills yet.' : 'Loading…'}</p>
            )}
        </section>
    );
}

function ProposalReview({ id, onDone }: { id: string; onDone: () => void }) {
    const [detail, setDetail] = useState<ProposalDetail>();
    const [draft, setDraft] = useState({
        name: '',
        description: '',
        skillMd: '',
    });
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        void api<ProposalDetail>(`/learning/proposals/${id}`).then((d) => {
            setDetail(d);
            setDraft({
                name: d.proposal.name,
                description: d.proposal.description,
                skillMd: d.proposal.skillMd,
            });
        });
    }, [id]);
    if (!detail) {
        return <p className={cn(MUTED, 'mt-2.5')}>Loading proposal…</p>;
    }
    const pending = detail.proposal.status === 'pending';
    const act = async (path: string, method: string, body: unknown = {}) => {
        setBusy(true);
        setError('');
        try {
            if (pending && path !== '/reject') {
                await api(`/learning/proposals/${id}`, 'PATCH', draft);
            }
            if (path) {
                await api(`/learning/proposals/${id}${path}`, method, body);
            }
            onDone();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <section aria-label="Proposal review" data-slot="learning-review" className="mt-2.5 flex flex-col gap-1.5">
            <FieldLabel htmlFor="skill-name">Name</FieldLabel>
            <Input
                id="skill-name"
                value={draft.name}
                disabled={!pending}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <FieldLabel htmlFor="skill-description">When to use it</FieldLabel>
            <Input
                id="skill-description"
                value={draft.description}
                disabled={!pending}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            <FieldLabel htmlFor="skill-body">SKILL.md</FieldLabel>
            {/* 16px below md, so iOS doesn't zoom in on focus (CB-96). */}
            <Textarea
                id="skill-body"
                rows={10}
                value={draft.skillMd}
                disabled={!pending}
                className="resize-y font-mono text-base leading-relaxed field-sizing-fixed md:text-xs"
                onChange={(e) => setDraft({ ...draft, skillMd: e.target.value })}
            />
            <Disclosure
                defaultOpen
                title={detail.current ? `Changes from published revision ${detail.current.revision}` : 'New skill'}
            >
                <pre
                    data-slot="learning-diff"
                    className="rounded-lg bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap"
                >
                    {lineDiff(detail.current?.skillMd ?? '', draft.skillMd).map((line, index) => (
                        <span
                            key={index}
                            data-diff={line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : 'same'}
                            className={cn(
                                line.kind === '+' && 'text-emerald-700 dark:text-emerald-400',
                                line.kind === '-' && 'text-destructive line-through',
                            )}
                        >
                            {line.kind} {line.text}
                            {'\n'}
                        </span>
                    ))}
                </pre>
            </Disclosure>
            <Disclosure
                title={`Evidence: ${detail.evidence.length} conversation${detail.evidence.length === 1 ? '' : 's'}. Check that nothing private made it into the skill.`}
            >
                {detail.evidence.map((thread) => (
                    <article
                        key={thread.threadId}
                        data-slot="learning-evidence"
                        className="my-2 border-l-2 pl-2.5 text-xs"
                    >
                        <strong>{thread.title}</strong>{' '}
                        <small className="text-[11px]">{thread.ownerId ?? 'unknown owner'}</small>
                        {thread.triage && (
                            <p data-slot="learning-evidence-triage" className="my-1 text-[11px] text-muted-foreground">
                                Triage: {triageLine(thread.triage)}
                            </p>
                        )}
                        {thread.messages.map((message, index) => (
                            <p key={index} className="my-1.5 leading-relaxed">
                                <em>{message.role}:</em> {message.content}
                            </p>
                        ))}
                    </article>
                ))}
            </Disclosure>
            {detail.proposal.rationale && <p className={cn(MUTED, 'mt-2')}>Why: {detail.proposal.rationale}</p>}
            {error && <ErrorNote>{error}</ErrorNote>}
            {pending ? (
                <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy} onClick={() => void act('/publish', 'POST')}>
                        Approve and publish
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('', 'PATCH')}>
                        Save edits
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('/reject', 'POST')}>
                        Reject
                    </Button>
                </div>
            ) : (
                <p className={cn(MUTED, 'mt-2')}>This proposal was {detail.proposal.status}.</p>
            )}
        </section>
    );
}

/** A section of the review that folds, like the <details> it replaced. */
function Disclosure({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
    return (
        <Collapsible defaultOpen={defaultOpen} className="mt-1">
            <CollapsibleTrigger className="group/trigger flex w-full items-start gap-1 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                <ChevronRight
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/trigger:rotate-90"
                />
                {title}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1.5">{children}</CollapsibleContent>
        </Collapsible>
    );
}

/** An error from the server, said where it happened. */
function ErrorNote({ children }: { children: ReactNode }) {
    return (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-[11px] leading-relaxed text-destructive">
            {children}
        </p>
    );
}

function ContainerPanel({ id, initial }: { id: string; initial?: ContainerDetail }) {
    const [detail, setDetail] = useState<ContainerDetail | undefined>(initial);
    // Analyze now has never worked: shown only while `learning-analyze-now` is on.
    const analyzeNow = useFlag('learning-analyze-now');
    // Pages past the first that "Load more" read; each poll reads them again.
    const [older, setOlder] = useState<OlderProposals>();
    const first = detail?.proposals ?? [];
    const firstIds = new Set(first.map((proposal) => proposal.id));
    const proposals = [...first, ...(older?.items.filter((proposal) => !firstIds.has(proposal.id)) ?? [])];
    // What a poll reads again: the list as shown, once it is past one page.
    const shown = useRef<LearningProposalView[]>([]);
    shown.current = older?.items.length ? proposals : [];
    // Bumped by "Load more", so a poll that started before it doesn't undo it.
    const loads = useRef(0);
    const polling = useRef(false);
    const seeded = useRef(!!initial);
    const [selected, setSelected] = useState<string>();
    const [error, setError] = useState('');
    const [loadingMore, setLoadingMore] = useState(false);
    // A read asked for while one is on its way runs once that one ends.
    const again = useRef(false);
    // The container's tag: a poll with no change is a 304 (api.ts), which
    // keeps `held`, the first page shown; pages past it are read again.
    const [tags] = useState(() => new PollTags());
    const held = useRef(initial);
    const load = useCallback(async (): Promise<void> => {
        if (polling.current) {
            again.current = true;
            return;
        }
        polling.current = true;
        const started = loads.current;
        try {
            // The list shows no proposal bodies; a proposal's review reads them.
            const path = `/learning/containers/${id}?bodies=false`;
            const answer = await apiIfChanged<ContainerDetail>(
                path,
                held.current?.id === id ? tags.get(path) : undefined,
            );
            const next = answer === UNCHANGED ? held.current! : answer.data;
            const refreshed = shown.current.length
                ? await refreshOlder(next.proposals, next.proposalsCursor, shown.current, (cursor, limit) =>
                      proposalsPage(id, cursor, limit),
                  )
                : undefined;
            if (answer !== UNCHANGED) {
                held.current = next;
                setDetail(next);
                tags.set(path, answer.tag);
            }
            if (loads.current === started) {
                setOlder(refreshed);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            polling.current = false;
        }
        if (again.current) {
            again.current = false;
            return load();
        }
    }, [id, tags]);
    useEffect(() => {
        if (seeded.current) {
            seeded.current = false;
        } else {
            void load();
        }
        const timer = setInterval(() => void load(), 3000);
        return () => clearInterval(timer);
    }, [load]);
    useLiveTopic(`learning:${id}`, load);
    const cursor = older ? older.cursor : detail?.proposalsCursor;
    const loadMore = async () => {
        if (!cursor || loadingMore) {
            return;
        }
        setLoadingMore(true);
        loads.current++;
        try {
            const page = await proposalsPage(id, cursor);
            setOlder((current) => ({
                items: [...(current?.items ?? []), ...page.items],
                cursor: page.nextCursor,
            }));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not load more.');
        } finally {
            setLoadingMore(false);
        }
    };
    if (!detail) {
        return <p className={MUTED}>Loading…</p>;
    }
    const act = async (path: string, method = 'POST', body: unknown = {}) => {
        setError('');
        try {
            await api(`/learning/containers/${id}${path}`, method, body);
            void load();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not update.');
        }
    };
    const lastRun = detail.runs[0];
    return (
        <section aria-label={`Container ${id}`} data-slot="learning-container" className="min-w-0">
            <header className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1 basis-64">
                    <h2 className={HEADING}>{id}</h2>
                    <p className={MUTED}>
                        {detail.newEvidence} new conversation
                        {detail.newEvidence === 1 ? '' : 's'} since the last analysis.
                        {lastRun && runLine(lastRun)}
                        {lastRun?.error ? ` ${lastRun.error}` : ''}
                    </p>
                </div>
                {detail.running ? (
                    <Button variant="outline" onClick={() => void act('/cancel')}>
                        Cancel analysis
                    </Button>
                ) : (
                    analyzeNow && (
                        <Button
                            disabled={!detail.configured || !detail.newEvidence}
                            aria-describedby={`learning-readiness-${id}`}
                            onClick={() => void act('/analyze')}
                        >
                            Analyze now
                        </Button>
                    )
                )}
            </header>
            <p id={`learning-readiness-${id}`} className={cn(MUTED, 'mt-2')}>
                {!detail.configured
                    ? 'Analysis needs an enabled default shared model. An operator can configure it under Settings → Inference; personal chat subscriptions are not used for Learning.'
                    : !detail.newEvidence
                      ? 'No new finished conversations to analyze. Conversations started after a socio joins this scope become evidence when they finish.'
                      : analyzeNow
                        ? 'Analysis runs daily after 02:00 server time, catches up after downtime, or starts now with Analyze now.'
                        : 'Analysis runs daily after 02:00 server time and catches up after downtime.'}
            </p>
            {error && (
                <div className="mt-3">
                    <ErrorNote>{error}</ErrorNote>
                </div>
            )}
            <h3 className={SECTION}>Proposals</h3>
            {proposals.length ? (
                <ul data-slot="learning-proposals" className={LIST}>
                    {proposals.map((proposal) => (
                        <li key={proposal.id} data-slot="learning-proposal" className={ITEM}>
                            <Button
                                variant="link"
                                aria-expanded={selected === proposal.id}
                                className="h-auto p-0 text-sm text-foreground"
                                onClick={() => setSelected(selected === proposal.id ? undefined : proposal.id)}
                            >
                                <strong>{proposal.name}</strong>
                            </Button>{' '}
                            <small className="text-xs">
                                {proposal.status} · {proposal.evidenceThreadIds.length} evidence
                            </small>
                            <p className={ITEM_TEXT}>{proposal.description}</p>
                            {selected === proposal.id && (
                                <ProposalReview
                                    id={proposal.id}
                                    onDone={() => {
                                        setSelected(undefined);
                                        void load();
                                    }}
                                />
                            )}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className={MUTED}>
                    No proposals yet. Analysis runs daily after 02:00
                    {analyzeNow
                        ? ', after 15 new conversations, or when you press Analyze now.'
                        : ' or after 15 new conversations.'}
                </p>
            )}
            {cursor && (
                <Button
                    variant="outline"
                    size="sm"
                    className="mt-2.5"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                >
                    Load more
                </Button>
            )}
            {detail.triage && <TriagePanel triage={detail.triage} onLabelled={() => void load()} />}
            <h3 className={SECTION}>Published</h3>
            {detail.published.length ? (
                <ul data-slot="learning-published" className={LIST}>
                    {detail.published.map((skill) => (
                        <li key={skill.name} data-slot="learning-skill" className={ITEM}>
                            <strong>{skill.name}</strong> <small className="text-xs">revision {skill.revision}</small>
                            <p className={ITEM_TEXT}>{skill.description}</p>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void act(`/skills/${skill.name}/revoke`)}
                            >
                                Revoke
                            </Button>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className={MUTED}>Nothing published in this container.</p>
            )}
            {detail.revision > 0 && (
                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                    Deliver
                    <Select
                        value={detail.pinned ? String(detail.pinned) : LATEST}
                        onValueChange={(value) =>
                            void act('/pin', 'PUT', {
                                revision: value === LATEST ? null : Number(value),
                            })
                        }
                    >
                        <SelectTrigger aria-label="Delivered revision" size="sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={LATEST}>the latest (revision {detail.revision})</SelectItem>
                            {Array.from({ length: detail.revision }, (_, i) => i + 1)
                                .reverse()
                                .map((revision) => (
                                    <SelectItem key={revision} value={String(revision)}>
                                        revision {revision} (pinned)
                                    </SelectItem>
                                ))}
                        </SelectContent>
                    </Select>
                </div>
            )}
        </section>
    );
}

/**
 * Learning on the classification seam (CB-200): whether triage is on, what
 * it cost today, and this container's conversations with their triage,
 * which an admin can label (the golden set an evaluation needs).
 */
function TriagePanel({ triage, onLabelled }: { triage: LearningSeamView; onLabelled: () => void }) {
    const [busy, setBusy] = useState<string>();
    const [error, setError] = useState('');
    const label = async (thread: LearningTriageView, value: LearningLabel) => {
        setBusy(thread.threadId);
        setError('');
        try {
            await api(`/learning/threads/${encodeURIComponent(thread.threadId)}/triage`, 'PUT', { label: value });
            onLabelled();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save the label.');
        } finally {
            setBusy(undefined);
        }
    };
    const shown = triage.enabled
        ? triage.threads
        : triage.threads.filter((thread) => thread.label || thread.score !== null);
    return (
        <section aria-label="Triage" data-slot="learning-triage">
            <h3 className={SECTION}>Triage</h3>
            <p className={MUTED} data-slot="learning-triage-status">
                {triage.enabled
                    ? `On, with ${triage.available ? triage.version : 'no model: set up a default shared model'}. ${
                          triage.passed
                              ? 'Its answers count: conversations it is sure are one-off stay out of the analysis, and it checks proposals for repeats and private details.'
                              : `Suggestions only until this version passes an evaluation against admins’ labels (${formatNumber(triage.golden)} of at least ${MIN_GOLDEN}); it still drops proposals it is sure hold private details.`
                      } An analysis also starts when one intent recurs in ${triage.intentRecurrence} sessions.`
                    : 'Off. With Learning triage on, the workspace’s model reads each new conversation’s title and what people asked, scrubbed of contact details and secrets, and only conversations that show a repeatable procedure go to the analysis.'}{' '}
                Last 24 hours: {formatNumber(triage.callsToday)} of {formatNumber(triage.perDay)} calls ·{' '}
                {formatNumber(triage.tokensToday)} tokens ·{' '}
                {triage.costToday === null ? 'cost not reported' : `$${triage.costToday.toFixed(4)}`}. Switch, threshold
                and daily cap:{' '}
                <a href="/operations/settings" className="underline underline-offset-2">
                    Operations → Settings
                </a>
                .
            </p>
            {error && <ErrorNote>{error}</ErrorNote>}
            {shown.length > 0 && (
                <ul data-slot="learning-triage-list" className={cn(LIST, 'mt-2')}>
                    {shown.map((thread) => (
                        <li key={thread.threadId} data-slot="learning-triage-item" className={ITEM}>
                            <strong className="text-sm break-words">{thread.title || 'Untitled conversation'}</strong>{' '}
                            <small className="text-xs text-muted-foreground">
                                {thread.pending ? 'new' : 'analyzed'}
                            </small>
                            <p className={ITEM_TEXT}>
                                {triageLine({
                                    label: thread.label?.value ?? null,
                                    source: thread.label?.source ?? null,
                                    score: thread.score,
                                    intent: thread.intent,
                                }) || 'Not triaged yet.'}
                            </p>
                            <div
                                role="group"
                                aria-label={`Label ${thread.title || 'this conversation'}`}
                                className="flex flex-wrap gap-2"
                            >
                                {(['repeatable', 'one-off'] as const).map((value) => {
                                    const pressed = thread.label?.source === 'admin' && thread.label.value === value;
                                    return (
                                        <Button
                                            key={value}
                                            size="sm"
                                            variant={pressed ? 'default' : 'outline'}
                                            aria-pressed={pressed}
                                            disabled={busy === thread.threadId}
                                            onClick={() => void label(thread, value)}
                                        >
                                            {LEARNING_LABEL_NAMES[value]}
                                        </Button>
                                    );
                                })}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

/** The delivered-revision choice for "no pin" (Select has no empty value). */
const LATEST = 'latest';

/** Learning: admins review proposals; everyone sees published skills. */
export function LearningView({ initial }: { initial?: LearningSeed } = {}) {
    const admin = useIsAdmin();
    const seed = initial?.admin === admin ? initial : undefined;
    const [containers, setContainers] = useState<ContainerSummary[] | undefined>(
        seed?.admin ? seed.containers : undefined,
    );
    const [selected, setSelected] = useState<string | undefined>(
        seed?.admin ? (seed.open?.id ?? seed.containers[0]?.id) : undefined,
    );
    const seeded = useRef(!!seed?.admin);
    useEffect(() => {
        if (!admin) {
            return;
        }
        // The list's tag: a poll with no change is a 304 (api.ts).
        const tags = new PollTags();
        const load = () =>
            void apiIfChanged<ContainerSummary[]>('/learning/containers', tags.get('/learning/containers')).then(
                (answer) => {
                    if (answer === UNCHANGED) {
                        return;
                    }
                    const list = answer.data;
                    tags.set('/learning/containers', answer.tag);
                    setContainers(list);
                    setSelected((current) => current ?? list[0]?.id);
                },
            );
        if (seeded.current) {
            seeded.current = false;
        } else {
            load();
        }
        const timer = setInterval(load, 5000);
        return () => clearInterval(timer);
    }, [admin]);
    if (!admin) {
        return <PublishedSkillList initial={seed?.admin ? undefined : seed?.skills} />;
    }
    return (
        <div data-slot="learning-view" className="grid items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
            <ScopeSettings
                onSaved={() => {
                    return api<ContainerSummary[]>('/learning/containers').then((list) => {
                        setContainers(list);
                        setSelected((current) =>
                            list.some((container) => container.id === current) ? current : list[0]?.id,
                        );
                    });
                }}
            />
            <nav aria-label="Learning containers" className="flex min-w-0 flex-col gap-1">
                {containers?.map((container) => (
                    <Button
                        key={container.id}
                        variant="ghost"
                        data-active={selected === container.id}
                        aria-current={selected === container.id ? 'true' : undefined}
                        className="h-auto min-w-0 flex-col items-start gap-0.5 rounded-[7px] px-3.5 py-3 text-left text-[13px] font-normal text-muted-foreground data-[active=true]:bg-accent data-[active=true]:text-foreground"
                        onClick={() => setSelected(container.id)}
                    >
                        <span className="w-full truncate">{container.id}</span>
                        <small className="text-[11px] whitespace-normal text-muted-foreground">
                            {container.pendingProposals} to review · {container.published} published
                            {container.running ? ' · analyzing' : ''}
                        </small>
                    </Button>
                ))}
                {containers && !containers.length && (
                    <p className={MUTED}>
                        No learning containers. Set one in a socio’s settings to start collecting evidence.
                    </p>
                )}
            </nav>
            {selected && (
                <ContainerPanel
                    key={selected}
                    id={selected}
                    initial={seed?.admin && seed.open?.id === selected ? seed.open : undefined}
                />
            )}
        </div>
    );
}
