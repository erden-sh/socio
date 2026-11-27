import { Brain, ChevronRight, CircleAlert, ListChecks, LoaderCircle, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { useTranslation } from '@socio/i18n/react';
import {
    fieldsOf,
    formatDuration,
    parseJson,
    spanMs,
    toolOutcome,
    workedMs,
    type ReasoningStep,
    type ToolStep,
    type TraceStep,
} from '@socio/shared/runs/turn-steps';

import { shimmer } from '../../../lib/shimmer';
import { openAppPath } from '../../pages/page-navigation';
import { Markdown } from '../ChatMarkdown';

import { ToolDetails } from './StepDetails';
import { toolLabel } from './tool-labels';

import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const seconds = (step: ReasoningStep) => {
    const ms = spanMs(step.span);
    return ms === undefined ? undefined : Math.round(ms / 1000);
};

/** "Thought for 12s" (shared's thoughtLabel, in the reader's words). */
function useThoughtLabel() {
    const { t } = useTranslation(['chat.trace']);
    return (step: ReasoningStep) => {
        const secs = seconds(step);
        return secs === undefined
            ? t('chat.trace:thought')
            : t('chat.trace:thought-for', { duration: formatDuration(Math.max(1, secs) * 1000) });
    };
}

/*
 * As quiet as the reasoning block it grew from: small muted text, no
 * cards. Its lines are summaries without the marker.
 */
const summary =
    'cursor-pointer list-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden';
const chevron =
    'shrink-0 opacity-70 transition-[rotate] duration-[120ms] motion-reduce:transition-none [details[open]>summary>&]:rotate-90';
const spin = 'animate-spin motion-reduce:animate-none';
/** Reasoning's paragraphs. */
const reasoning = '[:where(&)_p]:mt-0 [:where(&)_p]:mb-1.5';

/**
 * A turn's work in the chat (CB-72): one line, "Worked for 34s · 5 steps",
 * that opens to the steps, one line each ("Searched the board for
 * “export”", its time and how it went), each opening to what it took and
 * gave. Open while the turn runs, so its progress shows; folded once it
 * ends, unless the reader opened or closed it. A turn that only reasons
 * reads "Thinking", then "Thought for 12s", folded, and opens to the
 * reasoning, as before. Closed
 * parts are not rendered, so a long chat stays light.
 */
export function TurnTrace({
    steps,
    live,
    start,
    extra,
}: {
    steps: readonly TraceStep[];
    /** The turn is still running. */
    live: boolean;
    /** When the turn began (its user message), if known. */
    start?: number;
    /** Shown under the steps while open (the computer's screen). */
    extra?: ReactNode;
}) {
    const { t } = useTranslation(['chat.trace']);
    const thoughtLabel = useThoughtLabel();
    const [choice, setChoice] = useState<boolean>();
    const only = steps.length === 1 && steps[0].kind === 'reasoning' ? steps[0] : undefined;
    // Reasoning alone stays folded while it streams (CB-66).
    const open = choice ?? (live && !only);
    const failed = steps.filter(
        (step) => step.kind === 'tool' && toolOutcome(step.result, live).state === 'failed',
    ).length;
    const worked = workedMs(steps, start);
    const count = steps.length;
    const label = only
        ? only.streaming
            ? t('chat.trace:thinking')
            : thoughtLabel(only)
        : live
          ? t('chat.trace:working', { count })
          : worked === undefined
            ? t('chat.trace:worked-through', { count })
            : t('chat.trace:worked-for', { duration: formatDuration(worked), count });
    const Icon = only ? Brain : live ? LoaderCircle : ListChecks;
    return (
        <TooltipProvider delayDuration={300}>
            <details
                className="mt-0.5 mb-1.5 min-w-0 self-stretch text-[12px] leading-[1.5] text-muted-foreground"
                data-slot="turn-trace"
                data-live={live || undefined}
                data-streaming={only?.streaming || undefined}
                open={open}
                onToggle={(event) => {
                    const next = event.currentTarget.open;
                    if (next !== open) {
                        setChoice(next);
                    }
                }}
            >
                <summary
                    className={cn(
                        summary,
                        'inline-flex max-w-full items-center gap-1.5 rounded-[4px] px-[3px] hover:text-foreground',
                    )}
                >
                    <Icon size={13} aria-hidden="true" className={!only && live ? spin : undefined} />
                    <span className={(only ? only.streaming : live) ? shimmer : undefined}>{label}</span>
                    {failed > 0 && (
                        <span className="text-destructive">· {t('chat.trace:failed-count', { count: failed })}</span>
                    )}
                    <ChevronRight size={13} aria-hidden="true" className={chevron} />
                </summary>
                {open &&
                    (only ? (
                        <div
                            className={cn(
                                reasoning,
                                'mt-1.5 max-h-80 overflow-y-auto border-l-2 border-l-border py-0.5 pl-3',
                            )}
                        >
                            <Markdown>{only.text}</Markdown>
                        </div>
                    ) : (
                        <ol className="mt-1.5 ml-[9px] flex list-none flex-col gap-px border-l-2 border-l-border pl-2">
                            {steps.map((step) => (
                                <li key={step.id}>
                                    {step.kind === 'reasoning' ? (
                                        <ReasoningLine step={step} />
                                    ) : (
                                        <ToolLine step={step} live={live} />
                                    )}
                                </li>
                            ))}
                        </ol>
                    ))}
                {open && extra}
            </details>
            <SharedNotices steps={steps} />
        </TooltipProvider>
    );
}

/** One step's line: it opens to its details, rendered only then. */
function StepLine({
    kind,
    tool,
    state,
    icon: Icon,
    verb,
    detail,
    code,
    ms,
    children,
}: {
    kind: TraceStep['kind'];
    tool?: string;
    state: 'running' | 'done' | 'failed' | 'stopped';
    icon: typeof Brain;
    verb: string;
    detail?: string;
    code?: boolean;
    ms?: number;
    children: () => ReactNode;
}) {
    const { t } = useTranslation(['chat.trace']);
    const [open, setOpen] = useState(false);
    return (
        <details
            data-slot="trace-step"
            data-kind={kind}
            data-tool={tool}
            data-state={state}
            open={open}
            onToggle={(event) => setOpen(event.currentTarget.open)}
        >
            <summary
                className={cn(summary, 'flex min-h-7 items-center gap-2 rounded-[6px] px-1.5 py-[3px] hover:bg-muted')}
            >
                <Icon
                    size={14}
                    aria-hidden="true"
                    className={cn('shrink-0', state === 'failed' && 'text-destructive')}
                />
                <span className="min-w-0 flex-[1_1_auto] truncate">
                    <span className={kind === 'reasoning' && state === 'running' ? shimmer : 'text-foreground'}>
                        {verb}
                    </span>
                    {detail && (
                        <>
                            {' '}
                            <span
                                className={
                                    code ? 'font-[ui-monospace,SFMono-Regular,Menlo,monospace] text-[11px]' : undefined
                                }
                            >
                                {detail}
                            </span>
                        </>
                    )}
                </span>
                <span className="inline-flex shrink-0 items-center gap-2 tabular-nums">
                    {state === 'failed' && (
                        <span
                            className="inline-flex items-center gap-1 font-medium text-destructive"
                            data-slot="trace-step-failed"
                        >
                            <CircleAlert size={13} aria-hidden="true" />
                            {t('chat.trace:step.failed')}
                        </span>
                    )}
                    {state === 'stopped' && <span>{t('chat.trace:step.stopped')}</span>}
                    {state === 'running' && kind === 'tool' && (
                        <LoaderCircle size={13} className={spin} role="img" aria-label={t('chat.trace:step.running')} />
                    )}
                    {ms !== undefined && <span>{formatDuration(ms)}</span>}
                </span>
                <ChevronRight size={13} aria-hidden="true" className={chevron} />
            </summary>
            {open && children()}
        </details>
    );
}

function ReasoningLine({ step }: { step: ReasoningStep }) {
    const { t } = useTranslation(['chat.trace']);
    const thoughtLabel = useThoughtLabel();
    return (
        <StepLine
            kind="reasoning"
            state={step.streaming ? 'running' : 'done'}
            icon={Brain}
            verb={step.streaming ? t('chat.trace:thinking') : thoughtLabel(step)}
        >
            {() => (
                <div className={cn(reasoning, 'mt-0.5 mb-2 ml-7 max-h-80 overflow-y-auto')}>
                    <Markdown>{step.text}</Markdown>
                </div>
            )}
        </StepLine>
    );
}

function ToolLine({ step, live }: { step: ToolStep; live: boolean }) {
    const outcome = toolOutcome(step.result, live);
    const label = toolLabel(
        step.call.function.name,
        fieldsOf(parseJson(step.call.function.arguments)),
        fieldsOf(parseJson(step.result)),
        outcome.state !== 'running',
    );
    return (
        <StepLine
            kind="tool"
            tool={step.call.function.name}
            state={outcome.state}
            icon={label.icon}
            verb={label.verb}
            detail={label.detail}
            code={label.code}
            ms={outcome.state === 'running' ? undefined : spanMs(step.span)}
        >
            {() => <ToolDetails step={step} outcome={outcome} />}
        </StepLine>
    );
}

/**
 * A write that went to a company socio's shared dataset (CB-337): the
 * server's notice, shown under the folded trace so the person sees it. The
 * server sends one per conversation, on the first such write.
 */
function SharedNotices({ steps }: { steps: readonly TraceStep[] }) {
    const { t } = useTranslation(['chat.trace']);
    const notices = steps.flatMap((step) => {
        if (step.kind !== 'tool') {
            return [];
        }
        const notice = fieldsOf(fieldsOf(parseJson(step.result)).notice);
        return notice.kind === 'shared_dataset' && typeof notice.text === 'string'
            ? [{ id: step.id, text: notice.text, href: typeof notice.href === 'string' ? notice.href : undefined }]
            : [];
    });
    return notices.map((notice) => (
        <p
            key={notice.id}
            className="mb-1.5 flex items-start gap-1.5 text-[12px] leading-[1.5] text-muted-foreground"
            data-slot="shared-data-notice"
        >
            <Users size={13} aria-hidden="true" className="mt-[3px] shrink-0" />
            <span>
                {notice.text}
                {notice.href?.startsWith('/data/datasets/') && (
                    <>
                        {' '}
                        <a
                            className="underline"
                            href={notice.href}
                            onClick={(event) => {
                                if (event.button || event.metaKey || event.ctrlKey) {
                                    return;
                                }
                                event.preventDefault();
                                openAppPath(notice.href!);
                            }}
                        >
                            {t('chat.trace:open-dataset')}
                        </a>
                    </>
                )}
            </span>
        </p>
    ));
}
