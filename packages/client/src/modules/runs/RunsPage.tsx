import { useNavigate, useSearchParams } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import { MODULE_IDS } from '@socio/shared/modules';
import type { RunList } from '@socio/shared/web/web';

import { useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';
import { useSlot } from '../context';

import { RunsView } from './RunsView';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/**
 * `/runs`: agent turns, the team's for admins and their own for members
 * (CB-128), plus the tabs other modules add through `runs.tabs`, chosen
 * by `?tab=`.
 */
export function RunsPage({ initial }: { initial?: RunList } = {}) {
    const { t } = useTranslation(['runs']);
    const { admin } = useShell();
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();
    const tabs = useSlot('runs.tabs');
    const turns = <RunsView initial={initial} onOpen={(id) => navigate(`/chats/${encodeURIComponent(id)}`)} />;
    return (
        <WorkspacePage
            slot="runs-page"
            module={MODULE_IDS.runs}
            title={t('runs:title')}
            description={t('runs:description', { context: admin ? 'admin' : undefined })}
        >
            {tabs.length ? (
                <Tabs
                    value={params.get('tab') ?? 'turns'}
                    onValueChange={(tab) => setParams(tab === 'turns' ? {} : { tab }, { replace: true })}
                    className="gap-4"
                >
                    <TabsList aria-label={t('runs:tabs.label')}>
                        <TabsTrigger value="turns">{t('runs:tabs.turns')}</TabsTrigger>
                        {tabs.map(({ key, Component }) => (
                            <Component key={key} part="trigger" />
                        ))}
                    </TabsList>
                    <TabsContent value="turns">{turns}</TabsContent>
                    {tabs.map(({ key, Component }) => (
                        <Component key={key} part="content" />
                    ))}
                </Tabs>
            ) : (
                turns
            )}
        </WorkspacePage>
    );
}
