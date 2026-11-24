import { ListTodo } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { IssueTitle } from '@socio/shared/issues/issue-types';

import { api } from '../../lib/api';
import { HomeWidget } from '../../shell/HomeWidget';

/** Open issues and how many wait in triage, loaded once (titles only). */
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
    return (
        <HomeWidget
            icon={ListTodo}
            tone="orange"
            title="Issues"
            to="/issues"
            value={counts ? `${counts.open} open` : '…'}
        >
            {counts ? `${counts.triage} in triage` : 'The team’s issue tracker'}
        </HomeWidget>
    );
}
