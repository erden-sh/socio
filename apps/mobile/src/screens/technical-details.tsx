import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';

import type { PushRow } from '../data/registry';
import { useCollections, useHasWorkspaceScope, useLiveQuery, useUnsent, useWorkspaceScope } from '../live';
import { BUILD_INFO } from '../platform/build-info';
import { useAdvanced } from '../platform/device-settings';
import { pushRegistration, usePushRefresh, usePushStatus } from '../platform/push';
import { BUILD_VARIANT } from '../platform/variant';
import type { PushStatus } from '../push';
import { pendingQuery, shellQuery, shellRows } from '../shell/queries';
import {
    ADVANCED_OFF,
    type BuildInfo,
    type DetailGroup,
    type DetailRow,
    laneGroups,
    NO_LANES,
    pushRows,
    syncGroups,
    versionRows,
    webLinks,
} from '../shell/technical-details';
import { MODULE_SNAPSHOTS } from '../sync/kinds';
import { SHELL_SNAPSHOTS } from '../sync/shell';
import { MINIMUM_SERVER_VERSION, NO_SERVER_VERSIONS } from '../sync/versions';
import { Button, AppSymbol, Screen, Text } from '../ui';

import { useOpenLink } from './open-link';
import { ListRow, Section } from './shell-parts';

// Technical details, from Settings
// while Advanced mode is on: the versions, each snapshot source's last pull,
// cursor and ETag, each outbox lane's rows, attempts and last error, and the
// web's coding sessions and computers. The rows are src/shell/technical-details.ts's;
// this draws them, ticking once a second so "12 s ago" stays true.

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

const BUILD: BuildInfo = {
    // The installed binary's version and build number (src/shell/build-info.ts).
    appVersion: BUILD_INFO.build === null ? BUILD_INFO.version : `${BUILD_INFO.version} build ${BUILD_INFO.build}`,
    variant: BUILD_VARIANT,
    platform: Platform.OS === 'ios' ? 'iOS' : 'Android',
    osVersion: Platform.OS === 'android' ? String(Platform.constants.Release) : String(Platform.Version),
};

export function TechnicalDetailsScreen() {
    const advanced = useAdvanced();
    const open = useHasWorkspaceScope();
    return (
        <Screen testID="technical-details-screen" edges={['right', 'bottom', 'left']}>
            {!advanced ? (
                <Text variant="subheadline" tone="muted">
                    {ADVANCED_OFF}
                </Text>
            ) : open ? (
                <WorkspaceDetails />
            ) : (
                <Section title="Versions" testID="tech-versions">
                    <Rows rows={versionRows(BUILD, NO_SERVER_VERSIONS, MINIMUM_SERVER_VERSION, NO_USER_DB)} />
                </Section>
            )}
        </Screen>
    );
}

const NO_USER_DB = { version: 0, writable: false };

/** A clock that ticks once a second while the screen shows. */
function useNow(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    return now;
}

/** The registry's push row for the workspace, read again whenever its push status changes. */
function usePushRegistration(id: string, status: PushStatus): PushRow | null {
    const [registration, setRegistration] = useState<PushRow | null>(null);
    useEffect(() => {
        let current = true;
        pushRegistration(id).then(
            (row) => {
                if (current) {
                    setRegistration(row);
                }
            },
            (error: unknown) => console.warn('[technical details] could not read the push registration', error),
        );
        return () => {
            current = false;
        };
    }, [id, status]);
    return registration;
}

function WorkspaceDetails() {
    const scope = useWorkspaceScope();
    const collections = useCollections();
    const now = useNow();
    const { data: pending } = useLiveQuery({ query: pendingQuery(collections) });
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { writes } = useUnsent();
    const openLink = useOpenLink();
    const lanes = laneGroups(pending, writes);
    const links = webLinks(shellRows(shell).workspace);
    const push = usePushStatus(scope.workspace.id);
    const refresh = usePushRefresh(scope.workspace.id);
    const registration = usePushRegistration(scope.workspace.id, push);
    return (
        <>
            <Section title="Versions" testID="tech-versions">
                <Rows rows={versionRows(BUILD, scope.versions.state(), MINIMUM_SERVER_VERSION, scope.userDb)} />
            </Section>
            <Section title="Push" testID="tech-push">
                <Rows rows={pushRows(push, registration, refresh, now)} />
            </Section>
            {syncGroups(scope.cache, [...SHELL_SNAPSHOTS, ...MODULE_SNAPSHOTS], now).map((group) => (
                <Group key={group.testID} heading="Sync" group={group} />
            ))}
            {lanes.length === 0 ? (
                <Section title="Outbox" testID="tech-outbox">
                    <View className="p-3">
                        <Text variant="footnote" tone="muted">
                            {NO_LANES}
                        </Text>
                    </View>
                </Section>
            ) : (
                lanes.map((group) => <Group key={group.testID} heading="Outbox lane" group={group} />)
            )}
            {links.length === 0 ? null : (
                <Section title="On the web" testID="tech-web">
                    {links.map((link, index) => (
                        <ListRow
                            key={link.testID}
                            testID={link.testID}
                            first={index === 0}
                            title={link.title}
                            subtitle={link.subtitle}
                            leading={<AppSymbol name="external-link" size={20} color="muted-foreground" />}
                            leadingSize={20}
                            accessibilityLabel={`${link.title}, opens in your browser`}
                            onPress={() => openLink(link.path)}
                        />
                    ))}
                </Section>
            )}
        </>
    );
}

function Group({ heading, group }: { heading: string; group: DetailGroup }) {
    return (
        <Section title={`${heading} · ${group.title}`} testID={group.testID}>
            <Rows rows={group.rows} />
        </Section>
    );
}

function copyText(text: string) {
    Clipboard.setStringAsync(text).catch((error: unknown) => console.warn('[technical] not copied', error));
}

function Rows({ rows }: { rows: readonly DetailRow[] }) {
    return (
        <View className="gap-1 p-3">
            {rows.map((row) => (
                <View key={row.testID} testID={row.testID} className="min-h-8 flex-row items-center gap-3">
                    <Text variant="footnote" tone="muted" className="w-28">
                        {row.label}
                    </Text>
                    <Text variant="footnote" selectable className="flex-1" style={{ fontFamily: MONO }}>
                        {row.value}
                    </Text>
                    {row.copy ? (
                        <Button
                            label={`Copy ${row.label.toLowerCase()}`}
                            icon="copy"
                            iconOnly
                            variant="ghost"
                            onPress={() => copyText(row.value)}
                        />
                    ) : null}
                </View>
            ))}
        </View>
    );
}
