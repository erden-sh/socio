import type { ReactNode } from 'react';

import { MODULE_IDS } from '@socio/shared/modules';

import { useFlags } from '../../shell/flags';
import { SectionLayout, SectionNav } from '../../views/WorkspacePage';

import { RangeBar } from './RangeBar';
import { OPS_GROUPS, opsPath, type OpsSection } from './sections';
import { OpsSettings, useOpsQuery, useOpsSettingsState } from './use-ops';

/**
 * The section nav (SectionNav, as in Settings). Each link keeps the range
 * and filters, so moving between sections looks at the same slice.
 */
function OpsNav({ search }: { search: string }) {
    const on = useFlags()?.on;
    return (
        <SectionNav
            label="Operations"
            slot="ops-nav"
            groups={OPS_GROUPS.map((group) => ({
                label: group.label,
                items: group.sections
                    // A flagged page is listed while its flag is on (CB-169).
                    .filter((item) => !item.flag || !!on?.includes(item.flag))
                    .map((item) => ({
                        id: item.id,
                        label: item.label,
                        to: opsPath(item.id, search),
                    })),
            }))}
        />
    );
}

/**
 * An Operations page (CB-164), laid out like Settings: the section's
 * header, the section nav, the range bar for sections that read a range
 * and the section, using the page's whole width (CB-220). The dashboard's
 * settings (the reporting time zone) load once here for every section.
 */
export function OperationsLayout({
    section,
    children,
}: {
    /** A section, or a page under one (a chat's transcript). */
    section: Pick<OpsSection, 'label' | 'description' | 'ranged'>;
    children: ReactNode;
}) {
    const settings = useOpsSettingsState();
    const { search } = useOpsQuery();
    return (
        <OpsSettings.Provider value={settings}>
            <SectionLayout
                slot="operations-page"
                module={MODULE_IDS.operations}
                title={section.label}
                description={section.description}
                nav={<OpsNav search={search} />}
            >
                {section.ranged && <RangeBar key={search} />}
                {children}
            </SectionLayout>
        </OpsSettings.Provider>
    );
}
