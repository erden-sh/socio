import { browserTimeZone, TIME_ZONE_HEADER } from '@socio/shared/time-zone';

/**
 * The props every CopilotKitProvider in the app gets (ChatRuntime.tsx).
 *
 * `enableInspector: false` keeps CopilotKit's web inspector off in every
 * build mode. Without it the provider mounts the inspector in development
 * on localhost, and the inspector fetches a notification feed from
 * cdn.copilotkit.ai and posts usage events to telemetry.copilotkit.ai.
 * The builds also replace the inspector package with a stub
 * (no-web-inspector.ts, aliased in vite.config.ts), so its code never
 * ships. packages/client/tests/copilotkit-inspector.test.tsx checks both.
 *
 * `headers` carries the browser's time zone with every chat request
 * (CB-159), never in a message's text: a person whose profile has none
 * gets it saved there, and their turns speak in it. Read once, in the
 * browser; the server render sends none.
 */
const timeZone = typeof window === 'undefined' ? undefined : browserTimeZone();
const headers: Record<string, string> = timeZone ? { [TIME_ZONE_HEADER]: timeZone } : {};

export const copilotKitOptions = {
    runtimeUrl: '/api/copilotkit',
    enableInspector: false,
    headers,
} as const;
