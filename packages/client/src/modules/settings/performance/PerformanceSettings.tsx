import { useEffect, useState, useSyncExternalStore } from 'react';

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
            <h2 className="font-semibold">Performance recording</h2>
            <p className="text-sm text-muted-foreground">
                Start recording, repeat the slow action, then return here to stop and download the report. Recording
                follows you between pages and can resume after a reload. A reload starts a new sample.
            </p>
            <p className="text-sm text-muted-foreground">
                The report stays in this tab until you download it. It contains timings and sizes, with no page or
                message text, credentials, or URL parameters. Recording stops automatically after ten minutes and keeps
                at most 500 entries. Signing out clears it.
            </p>
            <p role="status" className="text-sm">
                {status.recording ? 'Recording' : 'Stopped'} · {status.recording ? count : status.entries} entries
            </p>
            <div className="flex flex-wrap gap-2">
                <Button onClick={() => startRecording()} disabled={status.recording}>
                    Start recording
                </Button>
                <Button variant="outline" onClick={stopRecording} disabled={!status.recording}>
                    Stop recording
                </Button>
                <Button variant="outline" onClick={download} disabled={!status.entries}>
                    Download report
                </Button>
                <Button variant="outline" onClick={clearRecording} disabled={!status.entries && !status.recording}>
                    Clear
                </Button>
            </div>
        </SettingsCard>
    );
}
