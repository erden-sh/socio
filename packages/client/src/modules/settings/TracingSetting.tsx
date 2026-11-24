import type { TraceSettings } from '@socio/shared/types';

import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

import { PermissionRow } from '@/components/form-fields';

/**
 * Turn traces (CB-128) in Settings → Workspace → General: whether they go
 * to an OpenTelemetry collector (the operator's `OTEL_EXPORTER_OTLP_*`),
 * and the switch that lets exported spans carry content (off by default),
 * saved over `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`. Members
 * read it; only admins change it.
 */
export function TracingSetting({
    settings,
    readOnly,
    mutate,
}: {
    settings: TraceSettings | undefined;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const auto = useAutosave({ includeContent: settings?.includeContent ?? false }, (value) =>
        mutate('/settings', 'PATCH', { tracing: value }),
    );
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="tracing">
                <AutosaveHeader title="Tracing" status={!readOnly ? auto.status : undefined}>
                    Every turn keeps a trace in Runs: its model rounds, tool calls, tokens and why it ended, without
                    content.{' '}
                    {settings?.exporting
                        ? 'Traces also go to the OpenTelemetry collector the server is set up with.'
                        : 'To send traces to an OpenTelemetry collector, the operator sets OTEL_EXPORTER_OTLP_ENDPOINT.'}
                </AutosaveHeader>
                <PermissionRow
                    title="Include content in traces"
                    checked={auto.value.includeContent}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { includeContent: on },
                            on ? 'Content in traces turned on, for turns from now' : 'Content in traces turned off',
                        )
                    }
                >
                    Off by default. When on, exported traces carry what people sent, the socio’s answer and each tool’s
                    input and output, cut to 4,000 characters each. Whoever can read the collector can read them.
                </PermissionRow>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">Only an admin can change this setting.</p>}
            </section>
        </SettingsCard>
    );
}
