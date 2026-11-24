import { useNavigate, useSearchParams } from 'react-router';

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
    const { admin } = useShell();
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();
    const tabs = useSlot('runs.tabs');
    const turns = <RunsView initial={initial} onOpen={(id) => navigate(`/chats/${encodeURIComponent(id)}`)} />;
    return (
        <WorkspacePage
            slot="runs-page"
            module={MODULE_IDS.runs}
            title="Runs"
            description={
                admin
                    ? 'Recent turns across the team, newest first. Failed turns show their error; open a conversation you can read, or a turn’s trace.'
                    : 'Your recent turns with socios, newest first. Open a turn’s trace to see each step it took, how long it took and why it ended.'
            }
        >
            {tabs.length ? (
                <Tabs
                    value={params.get('tab') ?? 'turns'}
                    onValueChange={(tab) => setParams(tab === 'turns' ? {} : { tab }, { replace: true })}
                    className="gap-4"
                >
                    <TabsList aria-label="Runs">
                        <TabsTrigger value="turns">Turns</TabsTrigger>
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
