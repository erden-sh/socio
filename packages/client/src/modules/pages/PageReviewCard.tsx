import { Check, FileText, ArrowUpRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useTranslation } from '@socio/i18n/react';
import type { ReviewedPage } from '@socio/shared/pages/page-library';
import {
    draftProblem,
    matchesReviewedDraft,
    pageReviewApproved,
    pageReviewDeclined,
    parsePageReviewArgs,
} from '@socio/shared/pages/page-review';
import { simpleHtmlToMarkdown } from '@socio/shared/text/simple-html';

import { onDemand } from '../../i18n/on-demand';
import { ApiError } from '../../lib/api';

import { openAppPath, spacePath } from './page-navigation';
import { decidePageReview, restorePageReview } from './page-review-decision';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** The card's buttons, and its alert lines (a draft that can't be saved). */
const reviewButton =
    "h-auto gap-1.5 rounded-[9px] px-[13px] py-[9px] text-xs font-normal disabled:opacity-55 [&_svg:not([class*='size-'])]:size-[15px]";
const alertLine = 'px-4.5 text-destructive';

/** Where a review stands, for its header's words (pages.review:phase). */
type ReviewPhase = 'deleted' | 'conflict' | 'saved' | 'checking' | 'ended' | 'invalid' | 'waiting' | 'ready';

/**
 * A socio's page draft for the person to approve or decline, in a chat.
 * Its words load on demand (pages.review): the live chat is client-only.
 * Exported for tests that render it where its words are in.
 */
export function PageReviewBody({
    args,
    status,
    result,
    respond,
    threadId,
    toolCallId,
    onSaved,
}: {
    args: unknown;
    status: string;
    result?: unknown;
    respond?: (result: unknown) => Promise<void>;
    threadId: string;
    toolCallId: string;
    onSaved: () => void;
}) {
    const { t } = useTranslation(['pages.review']);
    const draft = parsePageReviewArgs(args);
    // In progress: the Dot is still writing the draft, or it waits for an
    // earlier review in the same turn. After that the arguments are final, so
    // a draft that still does not read is shown as such, never as still
    // being prepared (CB-81).
    const waiting = status === 'inProgress';
    const invalid = !waiting && !draft.success;
    const asked = draft.success ? draft.data : readable(args);
    const [savedPage, setSavedPage] = useState<ReviewedPage>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [receiptReady, setReceiptReady] = useState(false);
    const [restoreAttempt, setRestoreAttempt] = useState(0);
    // The page this review saved was deleted since (the receipt answers 410).
    const [deleted, setDeleted] = useState(false);
    const pending = useRef(false);
    const finished = status === 'complete';
    // A draft edited before saving (on the app) matches through its result.
    const conflict = !!savedPage && !matchesReviewedDraft(savedPage, args, result);
    const saved = !!savedPage && !conflict;
    // A review saved with edits shows what was saved, not the socio's draft (RVL).
    const shown = saved && savedPage.reviewDraft ? savedPage.reviewDraft : asked;
    const pageId = savedPage?.id ?? '';
    const spaceId = savedPage?.spaceId ?? '';
    useEffect(() => {
        let active = true;
        setReceiptReady(false);
        setSavedPage(undefined);
        setError('');
        setDeleted(false);
        void restorePageReview(threadId, toolCallId)
            .then((page) => {
                if (!active) {
                    return;
                }
                setSavedPage(page ?? undefined);
                setReceiptReady(true);
            })
            .catch((cause) => {
                if (active && cause instanceof ApiError && cause.status === 410) {
                    setDeleted(true);
                } else if (active) {
                    setError(cause instanceof Error ? cause.message : t('pages.review:errors.restore'));
                }
            });
        return () => {
            active = false;
        };
    }, [threadId, toolCallId, restoreAttempt, t]);
    const decide = async (approved: boolean) => {
        if (!respond || !receiptReady || conflict || pending.current) {
            return;
        }
        pending.current = true;
        setBusy(true);
        setError('');
        try {
            const page = await decidePageReview(threadId, toolCallId, args, approved);
            if (!page) {
                await respond(pageReviewDeclined(args));
                return;
            }
            setSavedPage(page);
            onSaved();
            await respond(pageReviewApproved(page, spacePath(page.spaceId, page.id)));
        } catch (cause) {
            setReceiptReady(false);
            setError(cause instanceof Error ? cause.message : t('pages.review:errors.save'));
        } finally {
            pending.current = false;
            setBusy(false);
        }
    };
    const phase: ReviewPhase = deleted
        ? 'deleted'
        : conflict
          ? 'conflict'
          : saved
            ? 'saved'
            : !receiptReady
              ? 'checking'
              : finished
                ? 'ended'
                : invalid
                  ? 'invalid'
                  : waiting
                    ? 'waiting'
                    : 'ready';
    return (
        // No data-slot on the card or its body: the draft's Markdown keeps the
        // legacy resets (lists, headings), as in the transcript around it.
        <section
            className="my-3 w-full flex-none overflow-hidden rounded-2xl border border-border bg-card text-card-foreground"
            aria-label={t('pages.review:label')}
        >
            <header className="flex items-center gap-[9px] border-b border-border/70 px-4.5 py-3.5 text-xs text-foreground/80">
                <FileText size={17} />
                <strong>{t(`pages.review:phase.${phase}.title`)}</strong>
                <span className="ml-auto text-[11px] text-muted-foreground">
                    {t(`pages.review:phase.${phase}.badge`)}
                </span>
            </header>
            <div className="max-h-77.5 overflow-auto px-5.5 py-4.5 text-[13px]/[1.65] [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-[15px] [&_p]:my-2">
                <h3 className="mt-0 mb-3 text-xl tracking-[-0.5px]">
                    {shown.title || (waiting ? t('pages.review:preparing') : t('pages.review:untitled'))}
                </h3>
                {shown.content && (
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                            img: ({ alt }) => <span>{alt}</span>,
                            a: ({ href, children }) => (
                                <a href={href} target="_blank" rel="noreferrer">
                                    {children}
                                </a>
                            ),
                        }}
                    >
                        {simpleHtmlToMarkdown(shown.content)}
                    </ReactMarkdown>
                )}
            </div>
            {conflict && (
                <p role="alert" className={alertLine}>
                    {t('pages.review:conflict')}
                </p>
            )}
            {invalid && !finished && !saved && !conflict && (
                <p role="alert" className={alertLine}>
                    {t('pages.review:invalid', { problem: draftProblem(draft.error) })}
                </p>
            )}
            {error && (
                <p role="alert" className={alertLine}>
                    {error}
                </p>
            )}
            {!receiptReady && error && (
                <Button
                    type="button"
                    variant="outline"
                    className={cn(reviewButton, 'mx-4.5 mb-3')}
                    onClick={() => setRestoreAttempt((attempt) => attempt + 1)}
                >
                    {t('pages.review:retry')}
                </Button>
            )}
            <footer className="flex flex-wrap items-center gap-2.5 border-t border-border/70 bg-muted/40 px-4.5 py-3.5">
                {(saved || conflict) && pageId && spaceId && (
                    <Button
                        type="button"
                        className={reviewButton}
                        onClick={() => openAppPath(spacePath(spaceId, pageId))}
                    >
                        {conflict ? t('pages.review:open-saved') : t('pages.review:open')} <ArrowUpRight />
                    </Button>
                )}
                {!finished && respond && receiptReady && !conflict && (
                    <>
                        {(saved || !invalid) && (
                            <Button
                                type="button"
                                disabled={busy}
                                className={reviewButton}
                                onClick={() => void decide(true)}
                            >
                                <Check />
                                {busy
                                    ? t('pages.review:saving')
                                    : saved
                                      ? t('pages.review:continue')
                                      : t('pages.review:approve')}
                            </Button>
                        )}
                        {!saved && (
                            <Button
                                type="button"
                                variant="outline"
                                disabled={busy}
                                className={reviewButton}
                                onClick={() => void decide(false)}
                            >
                                {invalid ? t('pages.review:send-back') : t('pages.review:decline')}
                            </Button>
                        )}
                    </>
                )}
                {!saved && !conflict && (
                    <small className="text-[11px] text-muted-foreground">
                        {deleted
                            ? t('pages.review:hint.deleted')
                            : !receiptReady
                              ? t('pages.review:hint.checking')
                              : finished || invalid
                                ? t('pages.review:hint.not-saved')
                                : waiting
                                  ? t('pages.review:hint.waiting')
                                  : t('pages.review:hint.ready')}
                    </small>
                )}
            </footer>
        </section>
    );
}
/** The page review card (`PageReviewBody`), once its words are in. */
export const PageReviewCard = onDemand(['pages.review'], PageReviewBody);

/** Whatever title and text a draft that does not validate still has. */
function readable(args: unknown) {
    const { title, content } = (args ?? {}) as Record<string, unknown>;
    return {
        title: typeof title === 'string' ? title.trim() : '',
        content: typeof content === 'string' ? content : '',
    };
}
