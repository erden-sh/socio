import { Pause, Play } from 'lucide-react';

import { useTranslation } from '@socio/i18n/react';

import { HomeWidget } from '../../shell/HomeWidget';
import { useShell } from '../../shell/shell-context';

import { Button } from '@/components/ui/button';

/** Whether the Dots are working or paused; admins switch it here too. */
export function PausedWidget() {
    const { t } = useTranslation(['settings']);
    const { state, admin, mutate } = useShell();
    const paused = state.settings.paused;
    return (
        <HomeWidget
            icon={paused ? Pause : Play}
            tone={paused ? 'amber' : 'mint'}
            title={t('settings:paused.title')}
            value={paused ? t('settings:paused.paused') : t('settings:paused.active')}
            action={
                admin && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void mutate('/settings', 'PATCH', { paused: !paused })}
                    >
                        {paused ? t('settings:paused.resume') : t('settings:paused.pause')}
                    </Button>
                )
            }
        >
            {paused ? t('settings:paused.waiting') : t('settings:paused.scheduled', { count: state.tasks.length })}
        </HomeWidget>
    );
}
