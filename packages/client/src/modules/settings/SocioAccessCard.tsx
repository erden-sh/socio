import { Eye } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import type { ApprovalView } from '@socio/shared/approvals';
import {
    ACCESS_VERB,
    ACTION_PARAMS,
    minutesText,
    type AppAccessCard,
    type AppActionCard,
    type CardAppFacts,
    type SocioAccessCard,
} from '@socio/shared/socio-access';
import { inertText } from '@socio/shared/text/inert-text';

import { api } from '../../lib/api';
import { CodingRuntimeBody } from '../coding/CodingRuntimeCard';
import { CodingStartBody } from '../coding/CodingSessionCard';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * The consent cards of delegated app access (CB-232): platform facts
 * first (who, what, which app by its own origin and owner, for how long,
 * what it allows and never allows, who will see the answers), then the
 * socio's or the app's own words, quoted as theirs. Everything a socio or
 * an app wrote arrives inert from the server and is made inert again here:
 * it renders as text, never Markdown or links.
 */

/** Text from a socio or an app, shown as plain text whatever it holds. */
const inert = (value: string, max = ACTION_PARAMS.maxBytes + 1) => inertText(value, { max });

/** What Approve says for this card: "Allow", or "Allow for this task". */
export function allowLabel(card: SocioAccessCard | null | undefined) {
    if (!card) {
        return undefined;
    }
    return card.kind === 'app_access' && card.access !== 'read' ? 'Allow for this task' : 'Allow';
}

function AppFacts({ app }: { app: CardAppFacts }) {
    return (
        <dl
            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs"
            data-slot="socio-access-app"
        >
            <dt className="text-muted-foreground">App</dt>
            <dd className="m-0 font-medium">{inert(app.label, 200)}</dd>
            <dt className="text-muted-foreground">Address</dt>
            <dd className="m-0 font-mono [overflow-wrap:anywhere]">{app.origin}</dd>
            <dt className="text-muted-foreground">Owner</dt>
            {/* An owner names themselves: inert too. */}
            <dd className="m-0">{inert(app.owner, 200)}</dd>
        </dl>
    );
}

/** The socio's or the app's words, quoted as theirs. */
function Quoted({ who, text }: { who: string; text: string }) {
    return (
        <figure className="m-0 grid gap-0.5" data-slot="socio-access-quote">
            <figcaption className="text-xs text-muted-foreground">{who} says:</figcaption>
            <blockquote className="m-0 border-l-2 pl-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {inert(text, 600)}
            </blockquote>
        </figure>
    );
}

function AccessBody({ card }: { card: AppAccessCard }) {
    return (
        <div
            className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 text-sm"
            data-slot="socio-access-card"
            data-access={card.access}
        >
            <p className="m-0">
                <strong>{card.socioName}</strong> wants to <strong>{ACCESS_VERB[card.access]}</strong>{' '}
                <em>{inert(card.app.label, 200)}</em> for you for <strong>{minutesText(card.minutes)}</strong>.
            </p>
            <AppFacts app={card.app} />
            <div className="grid gap-0.5">
                <span className="text-xs font-medium">This lets it</span>
                <ul className="m-0 list-disc pl-5">
                    {card.allows.map((line) => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
            </div>
            <p className="m-0 text-muted-foreground">{card.never}</p>
            {card.visibleTo && (
                <p className="m-0 font-medium" data-slot="socio-access-visible">
                    {card.socioName}’s answers here are visible to everyone in {inert(card.visibleTo, 200)}.
                </p>
            )}
            {card.app.development && (
                <p className="m-0 text-amber-700 dark:text-amber-400">
                    This is a development app on your own socio’s computer: that socio can change its code, so these
                    limits rely on your trust in it.
                </p>
            )}
            {card.widens && (
                <p className="m-0 text-muted-foreground">
                    Allowing replaces the narrower access it has in this conversation.
                </p>
            )}
            {card.alwaysAsk && <p className="m-0 text-muted-foreground">This app asks for your decision every time.</p>}
            <Quoted who={card.socioName} text={card.task} />
        </div>
    );
}

/** Canonical JSON, indented when it parses (the whole of it); else as is. */
function readable(text: string) {
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        return text;
    }
}

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`);

function ActionBody({
    id,
    card,
    view,
    onOpened,
}: {
    id: string;
    card: AppActionCard;
    view: ApprovalView;
    onOpened?: () => void;
}) {
    const [full, setFull] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const paramsId = useId();
    const params = useRef<HTMLPreElement>(null);
    // The button that opened them goes: focus moves to what it opened.
    useEffect(() => {
        if (full !== undefined) {
            params.current?.focus();
        }
    }, [full]);
    const open = async () => {
        setBusy(true);
        setError('');
        try {
            const answer = await api<{ full: string }>(`/approvals/${encodeURIComponent(id)}/open`, 'POST');
            setFull(answer.full);
            onOpened?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not open the parameters.');
        } finally {
            setBusy(false);
        }
    };
    const shown = full ?? card.params.preview;
    const complete = full !== undefined || card.params.complete;
    return (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 text-sm" data-slot="socio-action-card">
            {card.operation ? (
                // A Socio data operation: the platform's words, not the app's.
                <p className="m-0" data-slot="data-operation">
                    <strong>{card.socioName}</strong> asks to {inert(card.operation.words, 200)} through{' '}
                    <em>{inert(card.app.label, 200)}</em> for you (Socio data operation{' '}
                    <code className="rounded bg-muted px-1 text-xs">{inert(card.operation.op, 100)}</code>
                    ). <Badge variant="outline">Consequential</Badge>
                </p>
            ) : (
                <p className="m-0">
                    <strong>{card.socioName}</strong> asks to run{' '}
                    <code className="rounded bg-muted px-1 text-xs">{inert(card.action, 200)}</code> in{' '}
                    <em>{inert(card.app.label, 200)}</em> for you. <Badge variant="outline">Consequential</Badge>
                </p>
            )}
            <AppFacts app={card.app} />
            <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1" aria-labelledby={paramsId}>
                <h4 id={paramsId} className="m-0 text-xs font-medium">
                    What will run: its parameters, as Socio received them ({kb(card.params.bytes)})
                </h4>
                {card.params.counts.length > 0 && (
                    <ul className="m-0 list-none p-0 text-xs" data-slot="param-counts">
                        {card.params.counts.map((item) => (
                            <li key={item.path}>
                                <strong>{item.count}</strong> {item.count === 1 ? 'item' : 'items'} in{' '}
                                <code>{inert(item.path, 200)}</code>
                            </li>
                        ))}
                    </ul>
                )}
                <pre
                    ref={params}
                    // Focusable, so a keyboard can scroll long parameters.
                    tabIndex={0}
                    aria-label="Parameters"
                    className="m-0 max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
                    data-slot="action-params"
                    data-complete={complete}
                >
                    {complete ? readable(inert(shown)) : inert(shown)}
                </pre>
                {!complete && (
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                            Showing the first {kb(ACTION_PARAMS.inlineBytes)} of {kb(card.params.bytes)}.
                            {view.status === 'pending' ? ' Open them all before you allow this.' : ''}
                        </span>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void open()}>
                            <Eye /> Show all parameters
                        </Button>
                    </div>
                )}
                {error && (
                    <p role="alert" className="m-0 text-xs text-destructive">
                        {error}
                    </p>
                )}
            </section>
            {card.display.length > 0 && (
                <section className="grid gap-0.5" aria-label="As described by the app" data-slot="app-display">
                    <span className="text-xs text-muted-foreground">As described by the app (its own words):</span>
                    <dl className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-xs">
                        {card.display.map((line, index) => (
                            <div key={index} className="contents">
                                <dt className="text-muted-foreground">{inert(line.label, 100)}</dt>
                                <dd className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                                    {inert(line.value, 400)}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </section>
            )}
        </div>
    );
}

/** The card body for a request whose capability has one. */
export function SocioAccessCardBody({
    id,
    view,
    onOpened,
}: {
    id: string;
    view: ApprovalView;
    /** The full parameters were opened: the request's view changed. */
    onOpened?: () => void;
}) {
    const card = view.card;
    if (!card) {
        return null;
    }
    if (card.kind === 'coding_session') {
        return <CodingStartBody card={card} />;
    }
    if (card.kind === 'coding_runtime') {
        return <CodingRuntimeBody card={card} />;
    }
    return card.kind === 'app_access' ? (
        <AccessBody card={card} />
    ) : (
        <ActionBody id={id} card={card} view={view} onOpened={onOpened} />
    );
}
