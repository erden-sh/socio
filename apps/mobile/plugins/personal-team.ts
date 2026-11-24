import { type ConfigPlugin, withEntitlementsPlist, withInfoPlist } from 'expo/config-plugins';

import { PUSH_INFO_PLIST_KEYS } from './push.ts';

// Personal Team builds: a contributor without a paid Apple
// team builds for their own iPhone. Their Personal Team can't use our bundle ids or sign push, Sign
// in with Apple or app groups, so the build takes a bundle id they control and drops those
// entitlements (T3 Code's withoutIosPersonalTeamCapabilities, vendored), and this file's plugin drops
// the keychain groups and socio-push's Info.plist keys (plugins/push.ts), so the app's items, the push
// keys included, stay in its own default group. The
// notification extension and the app group, once they exist, stay out of these builds too.
//
// SOCIO_IOS_PERSONAL_TEAM=1 turns it on, and SOCIO_IOS_PERSONAL_TEAM_BUNDLE_ID names the id. iOS
// only: Android builds ignore both.

export interface PersonalTeam {
    /** The bundle id the Personal Team signs instead of the variant's. */
    bundleIdentifier: string;
}

const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** The Personal Team build the environment asks for, or undefined for a normal build. */
export function iosPersonalTeam(env: Record<string, string | undefined>): PersonalTeam | undefined {
    const flag = env.SOCIO_IOS_PERSONAL_TEAM;
    if (!flag || flag === '0') {
        return undefined;
    }
    if (flag !== '1') {
        throw new Error(`SOCIO_IOS_PERSONAL_TEAM is "${flag}": use 1, or leave it unset.`);
    }
    const bundleIdentifier = env.SOCIO_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim() ?? '';
    if (!BUNDLE_ID.test(bundleIdentifier)) {
        throw new Error(
            'SOCIO_IOS_PERSONAL_TEAM=1 needs SOCIO_IOS_PERSONAL_TEAM_BUNDLE_ID, a reverse-DNS id you control, such as com.example.socio.',
        );
    }
    return { bundleIdentifier };
}

/** The entitlements this file's plugin strips, beside the vendored plugin's three. */
export const PERSONAL_TEAM_STRIPPED = ['keychain-access-groups'] as const;

/** Listed first in app.config.ts, beside the vendored strip, so its mod runs after every other plugin's. */
const withoutPersonalTeamKeychainGroups: ConfigPlugin = (config) =>
    withInfoPlist(
        withEntitlementsPlist(config, (next) => {
            for (const key of PERSONAL_TEAM_STRIPPED) {
                delete next.modResults[key];
            }
            return next;
        }),
        (next) => {
            for (const key of PUSH_INFO_PLIST_KEYS) {
                delete next.modResults[key];
            }
            return next;
        },
    );

export default withoutPersonalTeamKeychainGroups;
