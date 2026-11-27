import { ShieldCheck } from 'lucide-react';

import { useTranslation } from '@socio/i18n/react';
import type { ApprovalsState } from '@socio/shared/approvals';
import type { Dot } from '@socio/shared/types';

import { useInlinedOrOnDemand } from '../../i18n/on-demand';
import { LocalTime } from '../../lib/local-time';
import { DotPanel, DotPanelItem, DotPanelAction, useDotPanelData } from '../../shell/DotPanel';

/** How long ago, short: "Just now", "5m ago", "3h ago", then the date. */
function useAgo() {
    const { t } = useTranslation(['approvals.card']);
    return (value: number) => {
        const minutes = Math.floor((Date.now() - value) / 60000);
        return minutes < 1
            ? t('approvals.card:panel.now')
            : minutes < 60
              ? t('approvals.card:panel.minutes', { minutes: -minutes })
              : minutes < 1440
                ? t('approvals.card:panel.hours', { hours: -Math.floor(minutes / 60) })
                : t('approvals.card:panel.date', { at: new Date(value) });
    };
}

/**
 * A Dot's home page, Now (CB-89): what it asked the signed-in person and
 * is waiting for their decision. Only theirs (`/api/approvals` is). Its
 * words load on demand (approvals.card), with its data: nothing until both.
 */
export function DotApprovals({ dot }: { dot: Dot }) {
    const { data, failed } = useDotPanelData<ApprovalsState>('/approvals', 'approvals');
    const worded = useInlinedOrOnDemand(['approvals.card']);
    const { t } = useTranslation(['approvals.card']);
    const ago = useAgo();
    const pending = data?.pending.filter((item) => item.dotId === dot.id) ?? [];
    if (!worded) {
        return null;
    }
    return (
        <DotPanel
            slot="approvals"
            icon={ShieldCheck}
            tone="amber"
            title={t('approvals.card:panel.title')}
            count={pending.length}
            loading={!data && !failed}
            failed={failed}
            empty={failed ? t('approvals.card:panel.failed') : t('approvals.card:panel.empty')}
            action={<DotPanelAction to="/approvals">{t('approvals.card:panel.all')}</DotPanelAction>}
        >
            {pending.map((item) => (
                <DotPanelItem
                    key={item.id}
                    to={`/approvals/${encodeURIComponent(item.id)}`}
                    icon={<ShieldCheck />}
                    title={item.summary}
                    meta={<LocalTime value={item.createdAt} format={ago} />}
                />
            ))}
        </DotPanel>
    );
}
