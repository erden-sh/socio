import { useContext, type ReactNode } from 'react';
import { Link } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
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
    const { t } = useTranslation(['settings']);
    return (
        <SectionNav
            label={t('settings:title')}
            slot="settings-nav"
            groups={SETTINGS_GROUPS.map((group) => ({
                label: t(`settings:groups.${group.id}.title`),
                items: group.entries
                    .filter((item) => listed(item, access))
                    .map((item) => ({
                        id: item.id,
                        label: t(`settings:sections.${item.id}`),
                        to: item.path,
                        end: item.id !== 'operator' && !item.nested,
                    })),
            }))}
        />
    );
}

/** Which Socio this is (CB-165), with a link to the release notes. */
function SettingsVersion() {
    const { t } = useTranslation(['settings']);
    const app = useAppVersion();
    return (
        <p data-slot="settings-version" className="mt-8 min-h-4 text-xs text-muted-foreground">
            {app && (
                <>
                    {t('settings:version', { version: app.version })}
                    {app.commit && <> {t('settings:versionCommit', { commit: app.commit })}</>} ·{' '}
                    <Link to="/releases" className="underline underline-offset-2 hover:text-primary">
                        {t('settings:releaseNotes')}
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
    const { t } = useTranslation(['settings']);
    const access = useSettingsAccess();
    return (
        <SectionLayout
            slot="settings-page"
            module={MODULE_IDS.settings}
            title={t(`settings:groups.${group.id}.title`)}
            description={t(`settings:groups.${group.id}.description`)}
            measure="form"
            nav={<SettingsNav access={access} />}
            after={<SettingsVersion />}
        >
            {children}
        </SectionLayout>
    );
}
