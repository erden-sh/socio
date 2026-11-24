import { Pause, Play } from 'lucide-react';

import { HomeWidget } from '../../shell/HomeWidget';
import { useShell } from '../../shell/shell-context';

import { Button } from '@/components/ui/button';

/** Whether the Dots are working or paused; admins switch it here too. */
export function PausedWidget() {
    const { state, admin, mutate } = useShell();
    const paused = state.settings.paused;
    return (
        <HomeWidget
            icon={paused ? Pause : Play}
            tone={paused ? 'amber' : 'mint'}
            title="Socios"
            value={paused ? 'All socios are paused' : 'All socios are active'}
            action={
                admin && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void mutate('/settings', 'PATCH', { paused: !paused })}
                    >
                        {paused ? 'Resume' : 'Pause'}
                    </Button>
                )
            }
        >
            {paused
                ? 'Scheduled tasks wait until they resume.'
                : `${state.tasks.length} scheduled ${state.tasks.length === 1 ? 'task' : 'tasks'}`}
        </HomeWidget>
    );
}
