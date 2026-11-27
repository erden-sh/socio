import { Link } from 'react-router';

import { Trans, useTranslation } from '@socio/i18n/react';
import type { ApprovalView } from '@socio/shared/approvals';
import { MODULE_IDS } from '@socio/shared/modules';

import { useRouteParams } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';

import { ApprovalCard } from './ApprovalCard';

/** `/approvals/:approvalId`: one request (Telegram notices link here). */
export function ApprovalRequestPage({
    initial,
}: {
    /** The request from the page's loader. */
    initial?: ApprovalView;
} = {}) {
    const { t } = useTranslation(['approvals.card']);
    const { approvalId = '' } = useRouteParams();
    return (
        <WorkspacePage
            slot="approval-request-page"
            module={MODULE_IDS.approvals}
            title={t('approvals.card:request.title')}
            description={
                <Trans
                    t={t}
                    i18nKey="approvals.card:request.description"
                    components={{ all: <Link to="/approvals" /> }}
                />
            }
        >
            <div className="max-w-2xl">
                <ApprovalCard
                    key={approvalId}
                    id={approvalId}
                    initial={initial?.id === approvalId ? initial : undefined}
                />
            </div>
        </WorkspacePage>
    );
}
