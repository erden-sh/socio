import { useCallback, useContext, useEffect, useRef, useState } from 'react';

import { OPPOSITE, type MessageReactions, type ReactionKind, type ReactionsView } from '@socio/shared/chat/reactions';
import type { ReplyReportsState, ReportOutcome, ReportReason, ReportRemoval } from '@socio/shared/chat/reply-reports';

import { ApiError, PollTags, UNCHANGED, api, apiIfChanged } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { ShellContext } from '../../shell/shell-context';

/** How often a visible chat asks for other people's and devices' reactions. */
export const REACTIONS_POLL_MS = 5000;
/** How long "Could not save" stays under a message. */
export const FAILED_MS = 4000;

/** How long a quiet note about a report stays under a message. */
export const NOTICE_MS = 8000;

const NONE: MessageReactions = { counts: {}, mine: [] };

/**
 * What a confirmed thumbs-down carries (CB-382, docs/specs/REPLY-REPORTS.md
 * §3). `shownByOther`: the confirmation showed the line that another
 * person's message goes too.
 */
export interface ReportRequest {
    reason: ReportReason;
    note?: string;
    consent: string;
    shownByOther: boolean;
}

/** What a reaction's response says became of a report, besides the view. */
type SavedView = ReactionsView & { report?: ReportOutcome | ReportRemoval };

/** The quiet line a report's outcome gets, when there is one to say. */
export const REPORT_NOTICE: Partial<Record<ReportOutcome, string>> = {
    'not-sharing': 'Reports aren’t shared with Ingenio any more, so this is a plain thumbs-down.',
    'consent-changed': 'Reporting changed since you confirmed, so nothing was reported. It’s a plain thumbs-down.',
    unavailable: 'The report couldn’t be made this time, so this is a plain thumbs-down.',
};

export interface ReactionsApi {
    /** More than one person can see this chat: counts show from one. */
    shared: boolean;
    /** The conversation, for a report's preview. */
    threadId: string;
    of(messageId: string): MessageReactions;
    /**
     * Adds the reaction, or takes it back when it is the reader's own. A
     * thumbs-down being added may carry a confirmed report.
     */
    toggle(messageId: string, kind: ReactionKind, report?: ReportRequest): void;
    /** The message whose last change did not save. */
    failed?: string;
    /** Whether a thumbs-down may carry a report (`GET /api/workspace`'s `replyReports`). */
    reports: ReplyReportsState;
    /** A quiet line under a message (what became of a report). */
    notice?: { messageId: string; text: string };
    notify(messageId: string, text: string): void;
}

/** `view` with the reader's `kind` on the message added or taken back. */
export function withReaction(view: ReactionsView, messageId: string, kind: ReactionKind, add: boolean): ReactionsView {
    const current = view.messages[messageId] ?? NONE;
    const counts = { ...current.counts };
    let mine = current.mine;
    const drop = (gone: ReactionKind) => {
        if (!mine.includes(gone)) {
            return;
        }
        mine = mine.filter((item) => item !== gone);
        counts[gone] = (counts[gone] ?? 1) - 1;
        if (!counts[gone]) {
            delete counts[gone];
        }
    };
    if (add) {
        const opposite = OPPOSITE[kind];
        if (opposite) {
            drop(opposite);
        }
        if (!mine.includes(kind)) {
            mine = [...mine, kind];
            counts[kind] = (counts[kind] ?? 0) + 1;
        }
    } else {
        drop(kind);
    }
    const messages = { ...view.messages };
    if (mine.length || Object.keys(counts).length) {
        // The reader's report stays while their thumbs-down does (CB-382).
        const report = mine.includes('down') ? current.report : undefined;
        messages[messageId] = report ? { counts, mine, report } : { counts, mine };
    } else {
        delete messages[messageId];
    }
    return { ...view, messages };
}

/**
 * A conversation's reactions (CB-133): fetched alongside its history,
 * polled while the chat is in view (a 304 when nothing changed), and
 * refetched at once on another tab's note. A change shows at once and is
 * put back if the server refuses it.
 */
export function useReactions(threadId: string, enabled: boolean): ReactionsApi | undefined {
    const shell = useContext(ShellContext);
    const reports = shell?.workspace.replyReports ?? null;
    const refreshShell = shell?.refresh;
    const [view, setView] = useState<ReactionsView>();
    const [failed, setFailed] = useState<string>();
    const [notice, setNotice] = useState<{ messageId: string; text: string }>();
    const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(noticeTimer.current), []);
    const notify = useCallback((messageId: string, text: string) => {
        clearTimeout(noticeTimer.current);
        setNotice({ messageId, text });
        noticeTimer.current = setTimeout(() => setNotice(undefined), NOTICE_MS);
    }, []);
    const tags = useRef(new PollTags());
    // Writes in flight: a poll that answers meanwhile would undo the change.
    const writing = useRef(0);
    const path = `/conversations/${threadId}/reactions`;
    const current = useRef(view);
    current.current = view;
    const load = useCallback(
        async (isActive: () => boolean = () => true) => {
            try {
                const fresh = await apiIfChanged<ReactionsView>(path, tags.current.get(path));
                if (fresh === UNCHANGED || !isActive() || writing.current) {
                    return;
                }
                tags.current.set(path, fresh.tag);
                setView(fresh.data);
            } catch {
                // The next poll tries again; the chat reads fine without them.
            }
        },
        [path],
    );
    // At once on another tab's note; a tick waits while the shell re-reads
    // (a conversation this user left is never asked for).
    const canPoll = useLiveTopic(enabled ? `conversation:${threadId}` : undefined, () => load(canPoll));
    useEffect(() => {
        setView(undefined);
        tags.current.forget();
        if (!enabled) {
            return;
        }
        let active = true;
        const isActive = () => active;
        void load(isActive);
        const timer = setInterval(() => {
            if (document.visibilityState === 'visible' && canPoll()) {
                void load(isActive);
            }
        }, REACTIONS_POLL_MS);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, [enabled, load, canPoll]);
    const failure = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(failure.current), []);
    const toggle = useCallback(
        (messageId: string, kind: ReactionKind, report?: ReportRequest) => {
            const before = current.current;
            if (!before) {
                return;
            }
            const add = !(before.messages[messageId]?.mine ?? []).includes(kind);
            clearTimeout(failure.current);
            setFailed(undefined);
            setView(withReaction(before, messageId, kind, add));
            writing.current += 1;
            void api<SavedView>(
                `/conversations/${threadId}/messages/${encodeURIComponent(messageId)}/reactions/${kind}`,
                add ? 'PUT' : 'DELETE',
                add && kind === 'down' && report ? { report } : undefined,
            )
                .then(({ report: outcome, ...saved }) => {
                    tags.current.set(path, null);
                    setView(saved);
                    // None is an error (§3): a quiet line, and the shell
                    // reads whether sharing is on again.
                    const text = report && outcome ? REPORT_NOTICE[outcome as ReportOutcome] : undefined;
                    if (text) {
                        notify(messageId, text);
                        void refreshShell?.();
                    }
                })
                .catch((error: unknown) => {
                    setView(before);
                    setFailed(messageId);
                    failure.current = setTimeout(() => setFailed(undefined), FAILED_MS);
                    // A conversation or message that is gone says nothing more.
                    if (!(error instanceof ApiError)) {
                        tags.current.set(path, null);
                    }
                })
                .finally(() => {
                    writing.current -= 1;
                });
        },
        [threadId, path, notify, refreshShell],
    );
    if (!enabled || !view) {
        return undefined;
    }
    return {
        shared: view.shared,
        threadId,
        of: (messageId) => view.messages[messageId] ?? NONE,
        toggle,
        failed,
        reports,
        notice,
        notify,
    };
}
