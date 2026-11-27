import { CircleDot, ListTodo } from 'lucide-react';

import { useTranslation } from '@socio/i18n/react';
import { issuePath } from '@socio/shared/issues/issue-board';
import { issueKey, type DotFiledItem } from '@socio/shared/issues/issue-types';
import type { Dot } from '@socio/shared/types';

import { useInlinedOrOnDemand } from '../../i18n/on-demand';
import { DotPanel, DotPanelItem, DotPanelAction, useDotPanelData } from '../../shell/DotPanel';

import { useIssueTerms } from './issue-words';

/**
 * A Dot's home page, Earlier (CB-89): what it filed on the board for the
 * signed-in person, with each item's status now. Its words load on
 * demand (issues.slots, issues.terms), with its data: nothing until both.
 */
export function DotFilings({ dot }: { dot: Dot }) {
    const { data, failed } = useDotPanelData<DotFiledItem[]>(
        `/issues/filed?dot=${encodeURIComponent(dot.id)}`,
        'issues',
    );
    const worded = useInlinedOrOnDemand(['issues.slots', 'issues.terms']);
    const { t } = useTranslation(['issues.slots']);
    const terms = useIssueTerms();
    if (!worded) {
        return null;
    }
    return (
        <DotPanel
            slot="filings"
            icon={ListTodo}
            tone="orange"
            title={t('issues.slots:filings.title')}
            count={data?.length}
            loading={!data && !failed}
            failed={failed}
            empty={failed ? t('issues.slots:filings.failed') : t('issues.slots:filings.empty', { name: dot.name })}
            action={<DotPanelAction to="/issues">{t('issues.slots:filings.board')}</DotPanelAction>}
        >
            {data?.map((item) => (
                <DotPanelItem
                    key={item.number}
                    to={issuePath(item.number)}
                    icon={<CircleDot />}
                    title={t('issues.slots:filings.item', { key: issueKey(item.number), title: item.title })}
                    meta={terms.status(item.status)}
                />
            ))}
        </DotPanel>
    );
}
