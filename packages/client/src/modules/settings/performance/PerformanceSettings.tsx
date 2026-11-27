import { useEffect, useState, useSyncExternalStore } from 'react';

import { useTranslation } from '@socio/i18n/react';

import { SettingsCard } from '../AccountSettings';

import {
    clearRecording,
    exportRecording,
    recordingState,
    startRecording,
    stopRecording,
    subscribeRecording,
} from './recorder';

import { Button } from '@/components/ui/button';

const idle = { recording: false, entries: 0 };
export function PerformanceSettings() {
    const { t } = useTranslation(['settings.performance']);
    const status = useSyncExternalStore(subscribeRecording, recordingState, () => idle);
    const [count, setCount] = useState(status.entries);
    useEffect(() => {
        if (!status.recording) {
            return;
        }
        const timer = setInterval(() => setCount(recordingState().entries), 1000);
        return () => clearInterval(timer);
    }, [status.recording]);
    const download = () => {
        const blob = new Blob([JSON.stringify(exportRecording(), null, 2)], {
            type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'socio-performance.json';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return (
        <SettingsCard>
            <h2 className="font-semibold">{t('settings.performance:title')}</h2>
            <p className="text-sm text-muted-foreground">{t('settings.performance:intro')}</p>
            <p className="text-sm text-muted-foreground">{t('settings.performance:privacy')}</p>
            <p role="status" className="text-sm">
                {t('settings.performance:status', {
                    context: status.recording ? 'recording' : undefined,
                    count: status.recording ? count : status.entries,
                })}
            </p>
            <div className="flex flex-wrap gap-2">
                <Button onClick={() => startRecording()} disabled={status.recording}>
                    {t('settings.performance:start')}
                </Button>
                <Button variant="outline" onClick={stopRecording} disabled={!status.recording}>
                    {t('settings.performance:stop')}
                </Button>
                <Button variant="outline" onClick={download} disabled={!status.entries}>
                    {t('settings.performance:download')}
                </Button>
                <Button variant="outline" onClick={clearRecording} disabled={!status.entries && !status.recording}>
                    {t('settings.performance:clear')}
                </Button>
            </div>
        </SettingsCard>
    );
}
