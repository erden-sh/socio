import { AndroidConfig, type ConfigPlugin, withAndroidManifest } from 'expo/config-plugins';

import type { VariantName } from '../variant.ts';

import { type SourceSet, withResXml } from './res-xml.ts';

// Android's network security config, one per variant. Ours, not T3 Code's, which trusts user CAs
// and allows cleartext to every host.
//
// Release builds:
//
// - production: no cleartext, system CAs only;
// - preview and development: no cleartext, system and user CAs, for self-hosted test workspaces
//   on a private CA;
// - development also allows cleartext to `localhost`, `127.0.0.1` and `10.0.2.2` (the emulator's
//   address for the host), for local test servers.
//
// Debug builds (the development client) load their JavaScript from Metro on a developer's machine,
// over plain http, at whatever address Expo CLI hands them: `localhost` through `adb reverse`, or
// the machine's LAN or tailnet address for a phone on Wi-Fi (12.5). The config can't list address
// ranges, so a debug build gets a file of its own that allows cleartext to every host, as React
// Native's template does for its debug builds (`usesCleartextTraffic`, which Android ignores once
// this file exists). It keeps the variant's trust anchors. It goes in the source sets of both
// debuggable build types, `debug` and `debugOptimized`, under the same resource name, so it
// replaces main's file in those builds only: every release build keeps the rules above.
//
// In every variant and build, the vendor's own domains (directory, relay, links) get system CAs
// only and no cleartext, so a user-installed CA never vouches for them, and no pin-set: Cloudflare
// manages those certificates. None exist yet, so the list is empty and the files have no
// domain-config for them.

export const NETWORK_SECURITY_CONFIG = 'network_security_config';

/** The hosts a release build of the development variant may reach over plain http. */
export const CLEARTEXT_HOSTS = ['localhost', '127.0.0.1', '10.0.2.2'] as const;

/** The debuggable build types, which get the debug file, as React Native's Gradle plugin makes them. */
export const DEBUG_SOURCE_SETS = ['debug', 'debugOptimized'] as const satisfies readonly SourceSet[];

export interface NetworkSecurityOptions {
    variant: VariantName;
    /** The vendor's domains, subdomains included, trusted with system CAs only. */
    vendorDomains: readonly string[];
}

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function configXml({ variant, vendorDomains }: NetworkSecurityOptions, debug: boolean): string {
    for (const domain of vendorDomains) {
        if (!DOMAIN.test(domain)) {
            throw new Error(`"${domain}" isn't a lowercase domain name.`);
        }
    }
    const anchors = variant === 'production' ? ['system'] : ['system', 'user'];
    const lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<network-security-config>',
        `  <base-config cleartextTrafficPermitted="${debug}">`,
        '    <trust-anchors>',
        ...anchors.map((source) => `      <certificates src="${source}" />`),
        '    </trust-anchors>',
        '  </base-config>',
    ];
    if (variant === 'development' && !debug) {
        lines.push(
            '  <domain-config cleartextTrafficPermitted="true">',
            ...CLEARTEXT_HOSTS.map((host) => `    <domain includeSubdomains="false">${host}</domain>`),
            '  </domain-config>',
        );
    }
    if (vendorDomains.length > 0) {
        lines.push(
            '  <domain-config cleartextTrafficPermitted="false">',
            ...vendorDomains.map((domain) => `    <domain includeSubdomains="true">${domain}</domain>`),
            '    <trust-anchors>',
            '      <certificates src="system" />',
            '    </trust-anchors>',
            '  </domain-config>',
        );
    }
    lines.push('</network-security-config>', '');
    return lines.join('\n');
}

/** The XML of `src/main/res/xml/network_security_config.xml` for a variant: every release build's. */
export function networkSecurityConfigXml(options: NetworkSecurityOptions): string {
    return configXml(options, false);
}

/**
 * The XML of the debug build types' `network_security_config.xml` for a variant: cleartext to every
 * host, for Metro at any address, with the variant's trust anchors and vendor domains.
 */
export function debugNetworkSecurityConfigXml(options: NetworkSecurityOptions): string {
    return configXml(options, true);
}

const withNetworkSecurityConfig: ConfigPlugin<NetworkSecurityOptions> = (config, options) => {
    const xml = networkSecurityConfigXml(options);
    const debugXml = debugNetworkSecurityConfigXml(options);
    let next = withAndroidManifest(config, (mod) => {
        const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
        application.$['android:networkSecurityConfig'] = `@xml/${NETWORK_SECURITY_CONFIG}`;
        return mod;
    });
    next = withResXml(next, NETWORK_SECURITY_CONFIG, xml);
    for (const sourceSet of DEBUG_SOURCE_SETS) {
        next = withResXml(next, NETWORK_SECURITY_CONFIG, debugXml, sourceSet);
    }
    return next;
};

export default withNetworkSecurityConfig;
