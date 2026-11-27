import { ListTodo } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import type { IssueTitle } from '@socio/shared/issues/issue-types';

import { useOnDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';
import { HomeWidget } from '../../shell/HomeWidget';

/**
 * Open issues and how many wait in triage, loaded once (titles only). Its
 * words load on demand (issues.slots), with its data: nothing until they're in.
 */
export function OpenIssuesWidget() {
    const [counts, setCounts] = useState<{ open: number; triage: number }>();
    useEffect(() => {
        const controller = new AbortController();
        void api<IssueTitle[]>('/issues/titles?open=true', 'GET', undefined, controller.signal)
            .then((issues) =>
                setCounts({
                    open: issues.length,
                    triage: issues.filter((issue) => issue.status === 'triage').length,
                }),
            )
            .catch(() => undefined);
        return () => controller.abort();
    }, []);
    const worded = useOnDemand(['issues.slots']);
    const { t } = useTranslation(['issues.slots']);
    if (!worded) {
        return null;
    }
    return (
        <HomeWidget
            icon={ListTodo}
            tone="orange"
            title={t('issues.slots:widget.title')}
            to="/issues"
            value={counts ? t('issues.slots:widget.open', { count: counts.open }) : '…'}
        >
            {counts ? t('issues.slots:widget.triage', { count: counts.triage }) : t('issues.slots:widget.tracker')}
        </HomeWidget>
    );
}
