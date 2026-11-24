import { useContext, type ReactNode } from 'react';
import { Link } from 'react-router';

import { MODULE_IDS } from '@socio/shared/modules';

import { SignInSetup } from '../../shell/current-user';
import { useShell } from '../../shell/shell-context';
import { SectionLayout, SectionNav } from '../../views/WorkspacePage';

import { useAppVersion } from './app-version';
import { listed, SETTINGS_GROUPS, settingsAccess, type SettingsAccess, type SettingsGroup } from './sections';

/** Who is looking, from the shell and the sign-in methods. */
export function useSettingsAccess(): SettingsAccess {
    const { workspace } = useShell();
    return settingsAccess(workspace, !!useContext(SignInSetup));
}

/**
 * The section nav (SectionNav): each entry is a link, current from the
 * URL (Platform's on its backend pages too).
 */
export function SettingsNav({ access }: { access: SettingsAccess }) {
    return (
        <SectionNav
            label="Settings"
            slot="settings-nav"
            groups={SETTINGS_GROUPS.map((group) => ({
                label: group.label,
                items: group.entries
                    .filter((item) => listed(item, access))
                    .map((item) => ({
                        id: item.id,
                        label: item.label,
                        to: item.path,
                        end: item.id !== 'operator' && !item.nested,
                    })),
            }))}
        />
    );
}

/** Which Socio this is (CB-165), with a link to the release notes. */
function SettingsVersion() {
    const app = useAppVersion();
    return (
        <p data-slot="settings-version" className="mt-8 min-h-4 text-xs text-muted-foreground">
            {app && (
                <>
                    Socio v{app.version}
                    {app.commit && <> ({app.commit})</>} ·{' '}
                    <Link to="/releases" className="underline underline-offset-2 hover:text-primary">
                        Release notes
                    </Link>
                </>
            )}
        </p>
    );
}

/**
 * A settings page (CB-95, formerly the Settings dialog, CB-18): the
 * group's header, the section nav and the section's cards, and the
 * version below them, in the Issues page's frame (CB-220), the cards at a
 * width where forms still read well. Platform and its backend pages (the
 * operator module) use it too.
 */
export function SettingsLayout({ group, children }: { group: SettingsGroup; children: ReactNode }) {
    const access = useSettingsAccess();
    return (
        <SectionLayout
            slot="settings-page"
            module={MODULE_IDS.settings}
            title={group.label}
            description={group.description}
            measure="form"
            nav={<SettingsNav access={access} />}
            after={<SettingsVersion />}
        >
            {children}
        </SectionLayout>
    );
}
