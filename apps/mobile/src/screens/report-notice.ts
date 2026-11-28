import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { REPORT_NOTICE_MS, reportNotice } from '../chat/reply-reports';
import type { ReactionsState } from '../sync/reactions';

// The quiet line under a reply about its report (CB-382, §3): a report's
// outcome that has words (`reportNotice`), or what the screen says itself
// (`say`: the preview that couldn't be read). Each notice is its own object and
// carries its own expiry, `REPORT_NOTICE_MS` after it shows: a later outcome
// with no words leaves it to run out, and a later notice replaces it with its
// own time.

export interface ReportNotice {
    readonly messageId: string;
    readonly text: string;
}

export function useReportNotice(
    outcome: ReactionsState['report'],
    /** Called as an outcome with words shows (the shell read again); a stable function. */
    onOutcome: () => Promise<unknown>,
): { readonly notice: ReportNotice | null; readonly say: (messageId: string, text: string) => void } {
    const [notice, setNotice] = useState<ReportNotice | null>(null);
    const say = (messageId: string, text: string) => {
        setNotice({ messageId, text });
        AccessibilityInfo.announceForAccessibility(text);
    };
    useEffect(() => {
        if (outcome === undefined) {
            return;
        }
        const text = reportNotice(outcome.outcome);
        if (text === null) {
            return;
        }
        setNotice({ messageId: outcome.messageId, text });
        AccessibilityInfo.announceForAccessibility(text);
        onOutcome().catch(() => {});
        // A new outcome is a new object (its `seq`): the same outcome twice shows twice.
    }, [outcome, onOutcome]);
    // The expiry belongs to the notice shown: replaced, its timer goes with it.
    useEffect(() => {
        if (notice === null) {
            return undefined;
        }
        const timer = setTimeout(() => setNotice((now) => (now === notice ? null : now)), REPORT_NOTICE_MS);
        return () => clearTimeout(timer);
    }, [notice]);
    return { notice, say };
}
