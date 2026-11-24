// The app's package scripts that start Expo's dev server must not announce it on the network.
// Expo CLI 58 advertises Metro over Bonjour (multicast DNS) on every interface unless
// EXPO_UNSTABLE_BONJOUR is false (`@expo/cli` env.js: on by default outside headless runs), and
// EXPO_OFFLINE doesn't turn it off. tests/integration/apps-isolation.test.ts holds the telemetry
// switches; this file holds the Bonjour one (CB-353).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
    scripts: Record<string, string>;
};

/** `expo start` and `expo run:<platform>` start the dev server; `export`, `prebuild` and `config` don't. */
const STARTS_DEV_SERVER = /(^|\s)expo\s+(start|run:\w+)(\s|$)/;

/** The `KEY=value` words cross-env sets before the command. */
function envBefore(script: string, command: RegExp): string[] {
    const at = script.search(command);
    return script
        .slice(0, at)
        .split(/\s+/)
        .filter((word) => word.includes('='));
}

export function devServerScripts(scripts: Record<string, string>): [string, string][] {
    return Object.entries(scripts).filter(([, script]) => STARTS_DEV_SERVER.test(script));
}

export function announcing(scripts: Record<string, string>): string[] {
    return devServerScripts(scripts)
        .filter(([, script]) => !envBefore(script, STARTS_DEV_SERVER).includes('EXPO_UNSTABLE_BONJOUR=0'))
        .map(([name]) => name);
}

describe('dev-server scripts', () => {
    it('are start, android and ios', () => {
        expect(devServerScripts(pkg.scripts).map(([name]) => name)).toEqual(['start', 'android', 'ios']);
    });

    it('turn Bonjour off', () => {
        expect(announcing(pkg.scripts)).toEqual([]);
    });

    it('fail on a script that starts the dev server and announces it', () => {
        expect(
            announcing({
                start: 'cross-env EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 DO_NOT_TRACK=1 expo start --dev-client',
                android: 'cross-env EXPO_UNSTABLE_BONJOUR=0 expo run:android',
                ios: 'cross-env EXPO_UNSTABLE_BONJOUR=1 expo run:ios',
                late: 'cross-env EXPO_OFFLINE=1 expo start EXPO_UNSTABLE_BONJOUR=0',
                build: 'cross-env EXPO_OFFLINE=1 expo export --platform ios',
            }),
        ).toEqual(['start', 'ios', 'late']);
    });
});
