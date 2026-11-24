import { type ConfigPlugin, withInfoPlist } from 'expo/config-plugins';

import type { VariantName } from '../variant.ts';

// iOS App Transport Security, per variant. ATS stays
// on in every build: arbitrary loads are never allowed. Expo's template also allows local
// networking in every build (plain http to unqualified and `.local` names and to local addresses);
// only the development variant keeps that, debug or release, for Metro and local test servers.
// Android goes by build type instead (network-security.ts): debug builds of every variant allow
// cleartext to any host, for Metro, and of the release builds only development's allows it, to
// `localhost`, `127.0.0.1` and `10.0.2.2`. This plugin owns the whole dictionary, so no exception
// domain slips in from elsewhere.

/** Info.plist's `NSAppTransportSecurity` for a variant. */
export function appTransportSecurity(variant: VariantName): Record<string, boolean> {
    return variant === 'development'
        ? { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true }
        : { NSAllowsArbitraryLoads: false };
}

const withAppTransportSecurity: ConfigPlugin<{ variant: VariantName }> = (config, { variant }) =>
    withInfoPlist(config, (next) => {
        next.modResults.NSAppTransportSecurity = appTransportSecurity(variant);
        return next;
    });

export default withAppTransportSecurity;
