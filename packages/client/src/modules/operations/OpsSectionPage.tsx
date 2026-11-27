import { useTranslation } from '@socio/i18n/react';

import { SettingsCard } from '../settings/AccountSettings';

import { AccessLogPage } from './AccessLogPage';
import { ActivitySection } from './ActivitySection';
import { CapabilitiesPage } from './CapabilitiesPage';
import { ComputerResourcesPanel } from './ComputerResourcesPanel';
import { CostPage } from './CostPage';
import { DeploymentResourcesPanel } from './DeploymentResourcesPanel';
import { FailureLabelSettings } from './FailureLabelSettings';
import { HealthSection } from './HealthSection';
import { KnowledgePage } from './KnowledgePage';
import { LearningTriageSettings } from './LearningTriageSettings';
import { OpsSettingsSection } from './OpsSettingsSection';
import { OverviewSection } from './OverviewSection';
import { PriceSyncSetting } from './PriceSyncSetting';
import { ReliabilitySection } from './ReliabilitySection';
import { ResourcePanel } from './ResourcePanel';
import { ResourceSettings } from './ResourceSettings';
import type { OpsSectionId } from './sections';
import { SessionGapSetting } from './SessionGapSetting';
import { SocioAccessPage } from './SocioAccessPage';
import { IntentSettings, ThemeSettings } from './ThemeSettings';
import { ThemesPage } from './ThemesPage';
import { ValueSection } from './ValueSection';

/** A section that later work fills in; its page and address exist already. */
function PendingSection({ id }: { id: OpsSectionId }) {
    const { t } = useTranslation(['operations', 'operations.dashboard']);
    return (
        <SettingsCard>
            <p className="m-0 text-muted-foreground" data-slot="ops-pending">
                {t('operations.dashboard:pending', { section: t(`operations:sections.${id}.label`) })}
            </p>
        </SettingsCard>
    );
}

/** One Operations page's content. */
export function OpsSectionPage({ id }: { id: OpsSectionId }) {
    switch (id) {
        case 'overview':
            return <OverviewSection />;
        case 'activity':
            return <ActivitySection />;
        case 'value':
            return <ValueSection />;
        case 'themes':
            return <ThemesPage />;
        case 'reliability':
            return <ReliabilitySection />;
        case 'settings':
            return (
                <>
                    <OpsSettingsSection />
                    <SessionGapSetting />
                    <ResourceSettings />
                    <PriceSyncSetting />
                    <FailureLabelSettings />
                    <IntentSettings />
                    <ThemeSettings />
                    <LearningTriageSettings />
                </>
            );
        case 'access-log':
            return <AccessLogPage />;
        case 'socio-access':
            return <SocioAccessPage />;
        case 'health':
            return (
                <>
                    <HealthSection />
                    <DeploymentResourcesPanel />
                    <ResourcePanel />
                    <ComputerResourcesPanel />
                </>
            );
        case 'knowledge':
            return <KnowledgePage />;
        case 'capabilities':
            return <CapabilitiesPage />;
        case 'cost':
            return <CostPage />;
        default:
            return <PendingSection id={id} />;
    }
}
