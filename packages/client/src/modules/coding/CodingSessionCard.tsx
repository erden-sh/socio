import { GitBranch } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
    CODING_END_WORDS,
    CODING_PRIVATE_LINE,
    type CodingSessionCard,
    type CodingSessionView,
} from '@socio/shared/coding/coding-sessions';
import { minutesText } from '@socio/shared/socio-access';
import { inertText } from '@socio/shared/text/inert-text';

import { api, ApiError } from '../../lib/api';

import { CodingExchangesSection } from './CodingExchangesSection';
import { CodingThreadTranscript } from './CodingThreadTranscript';

import { Badge } from '@/components/ui/badge';

/**
 * Coding sessions in the chat (CB-239): the start card the person
 * decides on (platform facts first, the socio's words last, quoted), and
 * the session card that follows a session while it runs: repository,
 * branch, model, state, tokens used of its budget, the agent's progress
 * and its pull request. Everything the agent or the socio wrote is shown
 * as plain text, never Markdown or links.
 */

const inert = (value: string, max = 2_000) => inertText(value, { max });
const GITHUB_URL = /^https:\/\/github\.com\//;

const tokens = (value: number) =>
    value >= 1_000_000
        ? `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)} M`
        : value >= 1_000
          ? `${Math.round(value / 1_000)} k`
          : String(value);

/** The approval card's body for `coding_session_read` and `_push`. */
export function CodingStartBody({ card }: { card: CodingSessionCard }) {
    return (
        <div
            className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 text-sm"
            data-slot="coding-session-card"
            data-push={card.push ? 'true' : 'false'}
        >
            <p className="m-0">
                <strong>{card.socioName}</strong> wants to work on{' '}
                <strong className="[overflow-wrap:anywhere]">{card.repository}</strong> for you for{' '}
                <strong>{minutesText(card.minutes)}</strong>.
            </p>
            <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                {/* The coding agent and its route (CB-326); older cards ran OpenCode. */}
                <dt className="text-muted-foreground">Coding agent</dt>
                <dd className="m-0" data-slot="coding-session-harness">
                    {card.harness?.label ?? 'OpenCode'}
                    {card.harness?.route === 'subscription'
                        ? ', outside Socio’s gateway'
                        : ', on Socio’s model gateway'}
                </dd>
                <dt className="text-muted-foreground">Base</dt>
                <dd className="m-0 font-mono [overflow-wrap:anywhere]">{card.base}</dd>
                {card.push && (
                    <>
                        <dt className="text-muted-foreground">Its branch</dt>
                        <dd className="m-0 font-mono [overflow-wrap:anywhere]">{card.branchPattern}</dd>
                    </>
                )}
                <dt className="text-muted-foreground">Model</dt>
                <dd className="m-0">
                    {card.model.label}
                    {card.plan
                        ? ', on your own plan'
                        : card.model.outsideProvider
                          ? `, at ${card.model.host ?? 'an outside provider'}`
                          : ', on the operator’s own servers'}
                </dd>
                <dt className="text-muted-foreground">Budget</dt>
                <dd className="m-0">{tokens(card.budgetTokens)} tokens</dd>
            </dl>
            {card.plan ? (
                <p className="m-0 font-medium text-amber-700 dark:text-amber-400" data-slot="coding-session-plan">
                    This session runs on your own {card.plan.label} plan: the repository’s code it works on goes to
                    OpenAI through your plan, and it uses your plan’s limits.
                </p>
            ) : (
                card.model.outsideProvider && (
                    <p
                        className="m-0 font-medium text-amber-700 dark:text-amber-400"
                        data-slot="coding-session-outside"
                    >
                        The repository’s code it works on is sent to {card.model.host ?? 'an outside provider'}.
                    </p>
                )
            )}
            <div className="grid gap-0.5">
                <span className="text-xs font-medium">It can</span>
                <ul className="m-0 list-disc pl-5">
                    {card.allows.map((line) => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
            </div>
            <p className="m-0 text-muted-foreground">{card.never}</p>
            {card.visibleTo && (
                <p className="m-0 font-medium" data-slot="coding-session-visible">
                    {card.socioName}’s answers here are visible to everyone in {inert(card.visibleTo, 200)}.
                </p>
            )}
            <figure className="m-0 grid gap-0.5">
                <figcaption className="text-xs text-muted-foreground">{card.socioName} says:</figcaption>
                <blockquote className="m-0 border-l-2 pl-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {inert(card.task, 600)}
                </blockquote>
            </figure>
        </div>
    );
}

function stateLabel(view: CodingSessionView) {
    if (view.state === 'ended') {
        return view.endReason ? (CODING_END_WORDS[view.endReason] ?? 'Ended') : 'Ended';
    }
    if (view.state === 'starting') {
        return 'Setting up';
    }
    return view.run?.state === 'running' ? 'Working' : 'Ready';
}

/** How often a live session's card asks again while something runs. */
const POLL_MS = 3_000;

/**
 * The session card: fetched from `/api/gateway/sessions/:id` (the
 * person's own only), and again every few seconds while the session is
 * setting up or its agent works, so OpenCode's progress shows as it goes.
 */
export function CodingSessionPanel({ id }: { id: string }) {
    const [view, setView] = useState<CodingSessionView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const live = !view || view.state === 'starting' || (view.state === 'ready' && view.run?.state === 'running');
    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setInterval> | undefined;
        const load = () =>
            api<CodingSessionView>(
                `/gateway/sessions/${encodeURIComponent(id)}`,
                'GET',
                undefined,
                controller.signal,
            ).then(
                (next) => {
                    setView(next);
                    setError(null);
                },
                (failure: unknown) => {
                    if (controller.signal.aborted) {
                        return;
                    }
                    setError(
                        // Someone else's session (a room's other members) reads as
                        // the neutral line, nothing of it.
                        failure instanceof ApiError && failure.status === 404
                            ? CODING_PRIVATE_LINE
                            : 'The session couldn’t be loaded.',
                    );
                },
            );
        void load();
        if (live) {
            timer = setInterval(() => void load(), POLL_MS);
        }
        return () => {
            controller.abort();
            clearInterval(timer);
        };
    }, [id, live]);
    if (error && !view) {
        return (
            <p className="m-0 text-sm text-muted-foreground" role="status">
                {error}
            </p>
        );
    }
    if (!view) {
        return (
            <p className="m-0 text-sm text-muted-foreground" role="status">
                Loading the coding session…
            </p>
        );
    }
    const run = view.run;
    return (
        <section
            className="grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-2 rounded-[0.75rem] border p-3 text-sm"
            aria-label={`Coding session on ${view.repository}`}
            data-slot="coding-session"
            data-state={view.state}
        >
            <header className="flex min-w-0 flex-wrap items-center gap-2">
                <GitBranch className="size-4 shrink-0" aria-hidden />
                <strong className="min-w-0 [overflow-wrap:anywhere]">{view.repository}</strong>
                <Badge variant={view.state === 'ended' ? 'outline' : 'secondary'}>{stateLabel(view)}</Badge>
            </header>
            <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-muted-foreground">Branch</dt>
                <dd className="m-0 font-mono [overflow-wrap:anywhere]">
                    {view.branch}
                    <span className="text-muted-foreground"> from {view.base}</span>
                </dd>
                <dt className="text-muted-foreground">Model</dt>
                <dd className="m-0">{inert(view.modelLabel, 80)}</dd>
                {view.harnessLabel && (
                    <>
                        <dt className="text-muted-foreground">Coding agent</dt>
                        <dd className="m-0">{inert(view.harnessLabel, 80)}</dd>
                    </>
                )}
                <dt className="text-muted-foreground">Tokens</dt>
                <dd className="m-0">
                    {tokens(view.tokens.used)} of {tokens(view.tokens.budget)}
                </dd>
                {/* Only a GitHub pull request is a link. */}
                {view.pullRequest && GITHUB_URL.test(view.pullRequest.url) && (
                    <>
                        <dt className="text-muted-foreground">Pull request</dt>
                        <dd className="m-0">
                            <a
                                href={view.pullRequest.url}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="underline underline-offset-3"
                            >
                                Draft #{view.pullRequest.number}
                            </a>
                        </dd>
                    </>
                )}
                {view.denials.length > 0 && (
                    <>
                        <dt className="text-muted-foreground">Refused</dt>
                        <dd className="m-0 [overflow-wrap:anywhere]">
                            {view.denials
                                .slice(0, 3)
                                .map((denial) => `${denial.target} (${denial.count})`)
                                .join(', ')}
                        </dd>
                    </>
                )}
            </dl>
            {run && run.kind === 'prompt' && (
                <div className="grid min-w-0 gap-1">
                    <span className="text-xs font-medium">
                        {run.state === 'running'
                            ? 'The agent is working'
                            : run.state === 'done'
                              ? 'Last prompt'
                              : 'Last prompt ended early'}
                    </span>
                    {run.state === 'running' && run.progress.length > 0 && (
                        <ol
                            className="m-0 grid min-w-0 list-none gap-0.5 p-0 font-mono text-xs text-muted-foreground"
                            aria-live="polite"
                        >
                            {run.progress.slice(-6).map((line, index) => (
                                <li key={`${index}-${line}`} className="[overflow-wrap:anywhere]">
                                    {inert(line, 240)}
                                </li>
                            ))}
                        </ol>
                    )}
                    {run.state !== 'running' && run.summary && (
                        <blockquote className="m-0 max-h-48 overflow-y-auto border-l-2 pl-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
                            {inert(run.summary, 4_000)}
                        </blockquote>
                    )}
                    {run.state !== 'running' && run.changedFiles.length > 0 && (
                        <p className="m-0 text-xs text-muted-foreground">
                            {run.changedFiles.length} file
                            {run.changedFiles.length === 1 ? '' : 's'} changed
                        </p>
                    )}
                </div>
            )}
            {view.resultsWithheld && (
                <p className="m-0 text-xs text-muted-foreground" data-slot="coding-session-withheld">
                    What the agent did is hidden: you can no longer use this repository.
                </p>
            )}
            {/* CB-326 step 4: the live transcript + host controls. The agent's
                words are inert; approvals are Socio's cards, not here.
                When results are withheld, the events page returns empty payloads,
                so only the event kinds and times show. */}
            <CodingThreadTranscript id={view.id} state={view.state} runState={view.run?.state} />
            {/* CB-326 step 5: the gateway exchange log viewer + export.
                Metadata + hashes only; bodies are the object store's job.
                The holder (this person) and admins. */}
            <CodingExchangesSection id={view.id} />
            {error && (
                <p className="m-0 text-xs text-muted-foreground" role="status">
                    {error}
                </p>
            )}
        </section>
    );
}
