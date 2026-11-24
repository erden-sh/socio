import { GraduationCap } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '../../lib/api';
import { HomeWidget } from '../../shell/HomeWidget';
import { useShell } from '../../shell/shell-context';

/** For admins: Learning proposals waiting for review, loaded once. */
export function ProposalsWidget() {
    const { admin } = useShell();
    const [pending, setPending] = useState<number>();
    useEffect(() => {
        if (!admin) {
            return;
        }
        const controller = new AbortController();
        void api<{ pendingProposals: number }[]>('/learning/containers', 'GET', undefined, controller.signal)
            .then((containers) => setPending(containers.reduce((sum, item) => sum + item.pendingProposals, 0)))
            .catch(() => undefined);
        return () => controller.abort();
    }, [admin]);
    if (!admin) {
        return null;
    }
    return (
        <HomeWidget
            icon={GraduationCap}
            tone="emerald"
            title="Learning"
            to="/learning"
            actionable={!!pending}
            value={
                pending === undefined
                    ? '…'
                    : pending
                      ? `${pending} ${pending === 1 ? 'proposal' : 'proposals'} to review`
                      : 'Nothing to review'
            }
        >
            Skills reach a socio only once you publish them.
        </HomeWidget>
    );
}
