import { Eye } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { Trans, useTranslation } from '@socio/i18n/react';
import type { ApprovalView } from '@socio/shared/approvals';
import {
    ACTION_PARAMS,
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

/**
 * What Approve says for a card: "Allow", or "Allow for this task";
 * undefined without a card (the caller's own word).
 */
export function useAllowLabel() {
    const { t } = useTranslation(['settings.shared']);
    return (card: SocioAccessCard | null | undefined) => {
        if (!card) {
            return undefined;
        }
        return card.kind === 'app_access' && card.access !== 'read'
            ? t('settings.shared:access.allowForTask')
            : t('settings.shared:access.allow');
    };
}

/** A size in words: bytes below 1 KB, else KB with one decimal. */
function useSize() {
    const { t } = useTranslation(['settings.shared']);
    return (bytes: number) =>
        bytes < 1024
            ? t('settings.shared:size.bytes', { count: bytes })
            : t('settings.shared:size.kb', { kb: bytes / 1024 });
}

function AppFacts({ app }: { app: CardAppFacts }) {
    const { t } = useTranslation(['settings.shared']);
    return (
        <dl
            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs"
            data-slot="socio-access-app"
        >
            <dt className="text-muted-foreground">{t('settings.shared:access.facts.app')}</dt>
            <dd className="m-0 font-medium">{inert(app.label, 200)}</dd>
            <dt className="text-muted-foreground">{t('settings.shared:access.facts.address')}</dt>
            <dd className="m-0 font-mono [overflow-wrap:anywhere]">{app.origin}</dd>
            <dt className="text-muted-foreground">{t('settings.shared:access.facts.owner')}</dt>
            {/* An owner names themselves: inert too. */}
            <dd className="m-0">{inert(app.owner, 200)}</dd>
        </dl>
    );
}

/** The socio's or the app's words, quoted as theirs. */
function Quoted({ who, text }: { who: string; text: string }) {
    const { t } = useTranslation(['settings.shared']);
    return (
        <figure className="m-0 grid gap-0.5" data-slot="socio-access-quote">
            <figcaption className="text-xs text-muted-foreground">
                {t('settings.shared:access.says', { who })}
            </figcaption>
            <blockquote className="m-0 border-l-2 pl-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {inert(text, 600)}
            </blockquote>
        </figure>
    );
}

function AccessBody({ card }: { card: AppAccessCard }) {
    const { t } = useTranslation(['settings.shared']);
    const duration =
        card.minutes % 60 === 0
            ? t('settings.shared:access.hours', { count: card.minutes / 60 })
            : t('settings.shared:access.minutes', { count: card.minutes });
    return (
        <div
            className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 text-sm"
            data-slot="socio-access-card"
            data-access={card.access}
        >
            <p className="m-0">
                <Trans
                    t={t}
                    i18nKey="settings.shared:access.wants"
                    values={{
                        socio: card.socioName,
                        verb: t(`settings.shared:access.verb.${card.access}`),
                        app: inert(card.app.label, 200),
                        duration,
                    }}
                    components={{ socio: <strong />, verb: <strong />, app: <em />, time: <strong /> }}
                />
            </p>
            <AppFacts app={card.app} />
            <div className="grid gap-0.5">
                <span className="text-xs font-medium">{t('settings.shared:access.letsIt')}</span>
                <ul className="m-0 list-disc pl-5">
                    {card.allows.map((line) => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
            </div>
            <p className="m-0 text-muted-foreground">{card.never}</p>
            {card.visibleTo && (
                <p className="m-0 font-medium" data-slot="socio-access-visible">
                    {t('settings.shared:access.visibleTo', {
                        socio: card.socioName,
                        place: inert(card.visibleTo, 200),
                    })}
                </p>
            )}
            {card.app.development && (
                <p className="m-0 text-amber-700 dark:text-amber-400">{t('settings.shared:access.development')}</p>
            )}
            {card.widens && <p className="m-0 text-muted-foreground">{t('settings.shared:access.widens')}</p>}
            {card.alwaysAsk && <p className="m-0 text-muted-foreground">{t('settings.shared:access.alwaysAsk')}</p>}
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
    const { t } = useTranslation(['settings.shared']);
    const kb = useSize();
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
            setError(e instanceof Error ? e.message : t('settings.shared:action.openFailed'));
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
                    <Trans
                        t={t}
                        i18nKey="settings.shared:action.operation"
                        values={{
                            socio: card.socioName,
                            words: inert(card.operation.words, 200),
                            app: inert(card.app.label, 200),
                            op: inert(card.operation.op, 100),
                        }}
                        components={{
                            socio: <strong />,
                            app: <em />,
                            op: <code className="rounded bg-muted px-1 text-xs" />,
                            badge: <Badge variant="outline" />,
                        }}
                    />
                </p>
            ) : (
                <p className="m-0">
                    <Trans
                        t={t}
                        i18nKey="settings.shared:action.run"
                        values={{
                            socio: card.socioName,
                            action: inert(card.action, 200),
                            app: inert(card.app.label, 200),
                        }}
                        components={{
                            socio: <strong />,
                            action: <code className="rounded bg-muted px-1 text-xs" />,
                            app: <em />,
                            badge: <Badge variant="outline" />,
                        }}
                    />
                </p>
            )}
            <AppFacts app={card.app} />
            <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1" aria-labelledby={paramsId}>
                <h4 id={paramsId} className="m-0 text-xs font-medium">
                    {t('settings.shared:action.paramsHeading', { size: kb(card.params.bytes) })}
                </h4>
                {card.params.counts.length > 0 && (
                    <ul className="m-0 list-none p-0 text-xs" data-slot="param-counts">
                        {card.params.counts.map((item) => (
                            <li key={item.path}>
                                <Trans
                                    t={t}
                                    i18nKey="settings.shared:action.items"
                                    count={item.count}
                                    values={{ count: item.count, path: inert(item.path, 200) }}
                                    components={{ n: <strong />, path: <code /> }}
                                />
                            </li>
                        ))}
                    </ul>
                )}
                <pre
                    ref={params}
                    // Focusable, so a keyboard can scroll long parameters.
                    tabIndex={0}
                    aria-label={t('settings.shared:action.params')}
                    className="m-0 max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
                    data-slot="action-params"
                    data-complete={complete}
                >
                    {complete ? readable(inert(shown)) : inert(shown)}
                </pre>
                {!complete && (
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                            {t('settings.shared:action.showing', {
                                shown: kb(ACTION_PARAMS.inlineBytes),
                                total: kb(card.params.bytes),
                                context: view.status === 'pending' ? 'pending' : undefined,
                            })}
                        </span>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void open()}>
                            <Eye /> {t('settings.shared:action.showAll')}
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
                <section
                    className="grid gap-0.5"
                    aria-label={t('settings.shared:action.described')}
                    data-slot="app-display"
                >
                    <span className="text-xs text-muted-foreground">{t('settings.shared:action.describedLead')}</span>
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
