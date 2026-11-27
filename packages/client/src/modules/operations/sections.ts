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
    /** It reads the range and filters, so the range bar shows above it. */
    ranged: boolean;
    /** Listed only while this feature flag is on for the admin (CB-169). */
    flag?: FlagKey;
}

export const OPS_HOME = '/operations';
/** A section's address, with the range and filters (`opsSearch`) to keep. */
export const opsPath = (id: OpsSectionId, search = '') =>
    `${id === 'overview' ? OPS_HOME : `${OPS_HOME}/${id}`}${search}`;

const section = (id: OpsSectionId, ranged = true, flag?: FlagKey): OpsSection => ({
    id,
    ranged,
    ...(flag ? { flag } : {}),
});

/**
 * The section nav, in two groups: what happened, then who looked and how
 * the dashboard is set up. Their names and intros are the `operations`
 * namespace's (`groups.<id>`, `sections.<id>.label` and `.description`).
 */
export const OPS_GROUPS: { id: 'dashboard' | 'oversight'; sections: OpsSection[] }[] = [
    {
        id: 'dashboard',
        sections: [
            section('overview'),
            section('activity'),
            section('value'),
            section('themes'),
            section('knowledge'),
            section('reliability'),
            section('capabilities'),
            section('health'),
            section('cost'),
        ],
    },
    {
        id: 'oversight',
        sections: [
            section('access-log', false),
            section('socio-access', false, 'socio-actor-access'),
            section('settings', false),
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
