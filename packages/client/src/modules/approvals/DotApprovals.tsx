import { ShieldCheck } from 'lucide-react';

import type { ApprovalsState } from '@socio/shared/approvals';
import type { Dot } from '@socio/shared/types';

import { LocalTime } from '../../lib/local-time';
import { DotPanel, DotPanelItem, DotPanelAction, useDotPanelData } from '../../shell/DotPanel';
import { relative } from '../activity/TaskPresentation';

/**
 * A Dot's home page, Now (CB-89): what it asked the signed-in person and
 * is waiting for their decision. Only theirs (`/api/approvals` is).
 */
export function DotApprovals({ dot }: { dot: Dot }) {
    const { data, failed } = useDotPanelData<ApprovalsState>('/approvals', 'approvals');
    const pending = data?.pending.filter((item) => item.dotId === dot.id) ?? [];
    return (
        <DotPanel
            slot="approvals"
            icon={ShieldCheck}
            tone="amber"
            title="Waiting for you"
            count={pending.length}
            loading={!data && !failed}
            failed={failed}
            empty={failed ? 'Could not load approvals.' : 'Nothing to approve.'}
            action={<DotPanelAction to="/approvals">Approvals</DotPanelAction>}
        >
            {pending.map((item) => (
                <DotPanelItem
                    key={item.id}
                    to={`/approvals/${encodeURIComponent(item.id)}`}
                    icon={<ShieldCheck />}
                    title={item.summary}
                    meta={<LocalTime value={item.createdAt} format={relative} />}
                />
            ))}
        </DotPanel>
    );
}
