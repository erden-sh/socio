import { useContext } from 'react';

import { SignInSetup } from '../../shell/current-user';
import { useShell } from '../../shell/shell-context';
import { CodingSettingsSection } from '../coding/CodingSettingsSection';
import { TelegramLink } from '../telegram/TelegramLink';
import { DictationPreference } from '../voice/DictationSettings';

import { AccessPolicySection } from './AccessPolicySection';
import { AccountSections, SettingsCard } from './AccountSettings';
import { ArchivedChatsSection } from './ArchivedChats';
import { ChatSkillsSection } from './ChatSkillsSection';
import { ConnectedAgentsSection } from './ConnectedAgentsSection';
import { DataApiTokensSection } from './DataApiTokensSection';
import { DeletedSpacesSection } from './DeletedSpacesSection';
import { FeaturesSection } from './FeaturesSection';
import { InferenceSection } from './InferenceSection';
import { McpConnectionsSection } from './McpConnectionsSection';
import { NotificationsSection } from './NotificationsSection';
import { PeopleSection } from './people/PeopleSection';
import { PerformanceSettings } from './performance/PerformanceSettings';
import type { SettingsAccess, SettingsSectionId } from './sections';
import { SocioAccessSection } from './SocioAccessSection';
import { WorkspaceSecretsSection } from './WorkspaceSecretsSection';
import { WorkspaceSettings } from './WorkspaceSettings';

/** What needs real accounts says so on a server with mock sign-in. */
function NeedsSignIn() {
    return (
        <SettingsCard>
            <p className="text-muted-foreground" data-slot="needs-sign-in">
                This needs real accounts (Better Auth); this server signs in with the local picker.
            </p>
        </SettingsCard>
    );
}

/** One settings page's cards. */
export function SettingsSection({ id, access }: { id: SettingsSectionId; access: SettingsAccess }) {
    const shell = useShell();
    const methods = useContext(SignInSetup);
    switch (id) {
        case 'performance':
            return <PerformanceSettings />;
        case 'workspace':
            return <WorkspaceSettings state={shell.state} workspace={shell.workspace} mutate={shell.mutate} />;
        case 'people':
            // With Service accounts as a tab (CB-360); People needs real accounts.
            return <PeopleSection signIn={access.signIn} />;
        case 'access':
            return <AccessPolicySection onSignedOut={() => (shell.sessionEnded ?? shell.switchUser)?.()} />;
        case 'secrets':
            return (
                <SettingsCard>
                    <WorkspaceSecretsSection />
                </SettingsCard>
            );
        case 'data-api':
            return (
                <SettingsCard>
                    <DataApiTokensSection />
                </SettingsCard>
            );
        case 'chat-skills':
            return (
                <SettingsCard>
                    <ChatSkillsSection />
                </SettingsCard>
            );
        case 'deleted-spaces':
            return (
                <SettingsCard>
                    <DeletedSpacesSection />
                </SettingsCard>
            );
        case 'features':
            return <FeaturesSection key="features" page="features" />;
        case 'coding':
            return <CodingSettingsSection />;
        case 'early-access':
            return <FeaturesSection key="early-access" page="early-access" />;
        case 'features-dev':
            return <FeaturesSection key="features-dev" page="features-dev" />;
        case 'account':
            return (
                <>
                    <AccountSections
                        methods={methods}
                        onSignedOut={() => (shell.sessionEnded ?? shell.switchUser)?.()}
                    />
                    <DictationPreference />
                    <SettingsCard>
                        <McpConnectionsSection key={shell.workspace.user.id} />
                    </SettingsCard>
                </>
            );
        case 'notifications':
            return <NotificationsSection telegram={access.telegram} />;
        case 'inference':
            return (
                <SettingsCard>
                    <InferenceSection />
                </SettingsCard>
            );
        case 'archived-chats':
            return (
                <SettingsCard>
                    <ArchivedChatsSection onOpenChat={() => {}} />
                </SettingsCard>
            );
        case 'connected-agents':
            return access.signIn ? (
                <SettingsCard>
                    <ConnectedAgentsSection />
                </SettingsCard>
            ) : (
                <NeedsSignIn />
            );
        case 'telegram':
            return (
                <SettingsCard>
                    <TelegramLink />
                </SettingsCard>
            );
        case 'socio-access':
            return (
                <SettingsCard>
                    <SocioAccessSection key={shell.workspace.user.id} />
                </SettingsCard>
            );
    }
}
