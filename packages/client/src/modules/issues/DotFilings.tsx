import { CircleDot, ListTodo } from 'lucide-react';

import { issuePath, STATUS_LABEL } from '@socio/shared/issues/issue-board';
import { issueKey, type DotFiledItem } from '@socio/shared/issues/issue-types';
import type { Dot } from '@socio/shared/types';

import { DotPanel, DotPanelItem, DotPanelAction, useDotPanelData } from '../../shell/DotPanel';

/**
 * A Dot's home page, Earlier (CB-89): what it filed on the board for the
 * signed-in person, with each item's status now.
 */
export function DotFilings({ dot }: { dot: Dot }) {
    const { data, failed } = useDotPanelData<DotFiledItem[]>(
        `/issues/filed?dot=${encodeURIComponent(dot.id)}`,
        'issues',
    );
    return (
        <DotPanel
            slot="filings"
            icon={ListTodo}
            tone="orange"
            title="Filed on the board"
            count={data?.length}
            loading={!data && !failed}
            failed={failed}
            empty={failed ? 'Could not load its filings.' : `${dot.name} hasn’t filed anything for you.`}
            action={<DotPanelAction to="/issues">Board</DotPanelAction>}
        >
            {data?.map((item) => (
                <DotPanelItem
                    key={item.number}
                    to={issuePath(item.number)}
                    icon={<CircleDot />}
                    title={`${issueKey(item.number)} ${item.title}`}
                    meta={STATUS_LABEL[item.status]}
                />
            ))}
        </DotPanel>
    );
}
