import type { FlagKey } from '@socio/shared/flags';

/** The Operations dashboard's pages: Overview at `/operations`, the rest under it. */
export const OPS_SECTIONS = [
    'overview',
    'activity',
    'value',
    'themes',
    'knowledge',
    'reliability',
    'capabilities',
    'health',
    'cost',
    'access-log',
    'socio-access',
    'settings',
] as const;
export type OpsSectionId = (typeof OPS_SECTIONS)[number];

export interface OpsSection {
    id: OpsSectionId;
    label: string;
    /** The page's intro, under its title. */
    description: string;
    /** It reads the range and filters, so the range bar shows above it. */
    ranged: boolean;
    /** Listed only while this feature flag is on for the admin (CB-169). */
    flag?: FlagKey;
}

export const OPS_HOME = '/operations';
/** A section's address, with the range and filters (`opsSearch`) to keep. */
export const opsPath = (id: OpsSectionId, search = '') =>
    `${id === 'overview' ? OPS_HOME : `${OPS_HOME}/${id}`}${search}`;

const section = (id: OpsSectionId, label: string, description: string, ranged = true, flag?: FlagKey): OpsSection => ({
    id,
    label,
    description,
    ranged,
    ...(flag ? { flag } : {}),
});

/**
 * The section nav, in two groups: what happened, then who looked and how
 * the dashboard is set up.
 */
export const OPS_GROUPS: { label: string; sections: OpsSection[] }[] = [
    {
        label: 'Dashboard',
        sections: [
            section(
                'overview',
                'Overview',
                'The workspace at a glance: turns, people, failures and tokens, against the period before.',
            ),
            section('activity', 'Activity', 'Who works with which socios, how often, and through which channels.'),
            section('value', 'Value', 'Which work gets finished, which is left, and what people come back for.'),
            section(
                'themes',
                'Themes',
                'What people come to socios for: intents and recurring topics, and which get left unfinished.',
            ),
            section(
                'knowledge',
                'Knowledge',
                'Spaces and pages, datasets and storage: what is written, searched and used, what goes stale, and how full the limits are.',
            ),
            section('reliability', 'Reliability', 'What fails and why: turns, tools, retries and fallbacks.'),
            section(
                'capabilities',
                'Capabilities',
                'What socios can do, what they are asked for and can’t, and what gets used.',
            ),
            section('health', 'Health', 'Models, queues, schedules, backups, and how fresh these numbers are.'),
            section(
                'cost',
                'Cost',
                'What turns cost, by model, socio, person and backend; self-hosted backends’ cost pools; and the prices behind them.',
            ),
        ],
    },
    {
        label: 'Oversight',
        sections: [
            section(
                'access-log',
                'Access log',
                'Each time an admin opened a person’s activity, a chat or a turn’s trace. Every admin sees every entry.',
                false,
            ),
            section(
                'socio-access',
                'Socio access',
                'Which socios may use which apps for whom, right now, and ending that access.',
                false,
                'socio-actor-access',
            ),
            section(
                'settings',
                'Settings',
                'The reporting time zone the dashboard cuts days in, how sessions are cut, retention, the price sync, and what the model may label.',
                false,
            ),
        ],
    },
];

/** A section by its `:section` (none: Overview), or undefined for an unknown one. */
export function findOpsSection(id: string | undefined): OpsSection | undefined {
    const wanted = id ?? 'overview';
    // `/operations/overview` is `/operations`'s page under another name: not a page.
    if (id === 'overview') {
        return undefined;
    }
    for (const group of OPS_GROUPS) {
        for (const item of group.sections) {
            if (item.id === wanted) {
                return item;
            }
        }
    }
    return undefined;
}
