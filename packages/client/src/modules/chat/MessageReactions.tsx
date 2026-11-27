import type { Message } from '@ag-ui/core';
import { RefreshCw, ThumbsDown, ThumbsUp, Wrench, type LucideIcon } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';

import { REACTIONS, REACTION_LABELS, type ReactionKind } from '@socio/shared/chat/reactions';
import { REPORT_CONFIRMATION, type ReportPreview } from '@socio/shared/chat/reply-reports';
import { socioField } from '@socio/shared/runs/socio-fields';
import { SOCIO_METADATA } from '@socio/shared/types';

import { api } from '../../lib/api';
import { ShellContext } from '../../shell/shell-context';

import { RemoveSharedDialog, ReportDialog } from './ReportDialog';
import type { ReactionsApi } from './use-reactions';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const ICONS: Record<ReactionKind, LucideIcon> = {
    up: ThumbsUp,
    down: ThumbsDown,
    retry: RefreshCw,
    'needs-work': Wrench,
};

/**
 * The transcript the reactions are in (CB-382): the confirmation names the
 * socio whose reply it is. Whose message the reply answered is the
 * server's to say (`GET …/report`), never read from here.
 */
export const ReportTranscript = createContext<{ messages: readonly Message[] } | undefined>(undefined);

/** Said when the server couldn't say what a report would include. */
export const PREVIEW_FAILED = 'Couldn’t check what this report would include. Try again.';

/** `{socio}` when the reply's socio can't be named here. */
export const GENERIC_SOCIO = 'The socio';

/** `{author}` when the server's answer names nobody (an older server): it opens the sentence. */
export const OTHER_AUTHOR = 'Another person';

type Step =
    | { kind: 'checking' }
    | { kind: 'report'; consent: string; byOther?: string }
    | { kind: 'remove'; reaction: ReactionKind };

/**
 * The quick feedback buttons in a Dot message's action row (CB-133): good,
 * bad, try again and needs work. Each is a toggle; the reader's own are
 * highlighted, and a count shows beside a reaction when others can see the
 * chat (a team topic) or more than one person gave it.
 */
export function MessageReactions({ messageId, reactions }: { messageId: string; reactions: ReactionsApi }) {
    const current = reactions.of(messageId);
    // What a screen reader hears after a press ("Needs work added").
    const [said, setSaid] = useState('');
    const transcript = useContext(ReportTranscript);
    const dots = useContext(ShellContext)?.workspace.dots;
    const [step, setStep] = useState<Step>();
    const mounted = useRef(true);
    // Set again on each setup: Strict Mode runs the cleanup and setup twice.
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    // The reply's own socio: the runner stamps it on the stored reply's
    // metadata (`SOCIO_METADATA`); a room's transcript gives it as
    // `socioId` (CB-212). One missing or this reader can't name is "The
    // socio", never the socio the chat has selected now.
    const reply = transcript?.messages.find((message) => message.id === messageId);
    const stamped = socioField(reply, SOCIO_METADATA);
    const listed = (reply as { socioId?: unknown } | undefined)?.socioId;
    const socioId = typeof stamped === 'string' && stamped ? stamped : typeof listed === 'string' ? listed : '';
    const socio = (socioId && dots?.find((dot) => dot.id === socioId)?.name) || GENERIC_SOCIO;
    const send = (kind: ReactionKind, add = !current.mine.includes(kind)) => {
        setSaid(`${REACTION_LABELS[kind]} ${add ? 'added' : 'removed'}`);
        reactions.toggle(messageId, kind, { add });
    };
    // A thumbs-down that may be a report (§2, §3): ask the server what it
    // would include, then confirm. Nothing is sent until then.
    const startReport = async (consent: string) => {
        setStep({ kind: 'checking' });
        let preview: ReportPreview;
        try {
            preview = await api<ReportPreview>(
                `/conversations/${reactions.threadId}/messages/${encodeURIComponent(messageId)}/report`,
            );
        } catch {
            if (mounted.current) {
                setStep(undefined);
                reactions.notify(messageId, PREVIEW_FAILED);
            }
            return;
        }
        if (!mounted.current) {
            return;
        }
        if (!preview.sharing) {
            // Sharing went off since the workspace was read: a plain one.
            setStep(undefined);
            send('down', true);
            return;
        }
        setStep({
            kind: 'report',
            consent: preview.consent ?? consent,
            ...(preview.promptByOther ? { byOther: preview.author || OTHER_AUTHOR } : {}),
        });
    };
    const press = (kind: ReactionKind) => {
        const on = current.mine.includes(kind);
        const removesDown = current.mine.includes('down') && (kind === 'down' ? on : kind === 'up' && !on);
        if (removesDown && current.report === 'shared') {
            setStep({ kind: 'remove', reaction: kind });
            return;
        }
        if (kind === 'down' && !on && reactions.reports) {
            void startReport(reactions.reports.consent);
            return;
        }
        send(kind);
    };
    return (
        <div
            role="group"
            aria-label="React to this reply"
            className="flex items-center gap-0.5"
            data-slot="message-reactions"
        >
            {REACTIONS.map((kind) => {
                const Icon = ICONS[kind];
                const on = current.mine.includes(kind);
                const count = current.counts[kind] ?? 0;
                const shown = count > 0 && (reactions.shared || count > 1);
                const label = REACTION_LABELS[kind];
                return (
                    <Tooltip key={kind}>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                className={cn(
                                    'tabular-nums',
                                    on ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                                )}
                                aria-label={shown ? `${label}, ${count}` : label}
                                aria-pressed={on}
                                data-reaction={kind}
                                aria-busy={kind === 'down' && step?.kind === 'checking'}
                                onClick={() => {
                                    if (!step) {
                                        press(kind);
                                    }
                                }}
                            >
                                <Icon aria-hidden="true" />
                                {shown && <span className="text-[11px]">{count}</span>}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">{label}</TooltipContent>
                    </Tooltip>
                );
            })}
            {current.mine.includes('down') && current.report === 'shared' && (
                <span className="px-1 text-[11px] text-muted-foreground" data-slot="report-shared">
                    {REPORT_CONFIRMATION.shared}
                </span>
            )}
            {reactions.notice?.messageId === messageId && reactions.failed !== messageId && (
                <span className="px-1 text-[11px] text-muted-foreground" role="status" data-slot="report-notice">
                    {reactions.notice.text}
                </span>
            )}
            {step?.kind === 'report' && (
                <ReportDialog
                    socio={socio}
                    byOther={step.byOther}
                    onCancel={() => setStep(undefined)}
                    onConfirm={(choice) => {
                        setStep(undefined);
                        setSaid(`${REACTION_LABELS.down} added`);
                        reactions.toggle(messageId, 'down', {
                            add: true,
                            report: {
                                ...choice,
                                consent: step.consent,
                                shownByOther: step.byOther !== undefined,
                            },
                        });
                    }}
                />
            )}
            {step?.kind === 'remove' && (
                <RemoveSharedDialog
                    action={step.reaction === 'up' ? 'Switch to thumbs-up' : 'Remove thumbs-down'}
                    onCancel={() => setStep(undefined)}
                    onConfirm={() => {
                        setStep(undefined);
                        // What the warning said: remove the thumbs-down, or add the
                        // thumbs-up, whatever another device did meanwhile.
                        send(step.reaction, step.reaction === 'up');
                    }}
                />
            )}
            {reactions.failed === messageId && (
                <span className="px-1 text-[11px] text-destructive" role="alert">
                    Could not save that
                </span>
            )}
            <span className="sr-only" role="status">
                {reactions.failed === messageId ? '' : said}
            </span>
        </div>
    );
}

/** Whether any reaction is on the message: its row stays in view. */
export const hasReactions = (reactions: ReactionsApi | undefined, id: string) =>
    !!reactions && Object.keys(reactions.of(id).counts).length > 0;
