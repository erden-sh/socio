import type { StaticScreenProps } from '@react-navigation/native';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type MemberRow, membersView } from '../chat/room-people';
import { useBoundedState, useCollections, useHasWorkspaceScope, useLiveQuery, useWorkspaceScope } from '../live';
import { sociosQuery } from '../shell/queries';
import { Button, Text } from '../ui';

import { useOpenLink } from './open-link';
import { PersonAvatar, SocioMark } from './room-parts';

// A room's Members sheet, from the room header's
// socios: read-only, the people (the reader as "you", admins and invites
// said), then the socios (the lead said), and "Manage on the web" through
// useOpenLink, with its sign-in line: room administration is the web's.
// Its root is the ScrollView (iOS takes the first one as the sheet's).

export function RoomMembersScreen({ route }: StaticScreenProps<{ id: string }>) {
    return useHasWorkspaceScope() ? <RoomMembers id={route.params.id} /> : null;
}

function RoomMembers({ id }: { id: string }) {
    const scope = useWorkspaceScope();
    const insets = useSafeAreaInsets();
    const collections = useCollections();
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const openLink = useOpenLink();
    const { value } = useBoundedState(scope.roomViews.item(id));
    const members = value === null ? null : membersView(id, value, dots, scope.workspace.appUserId);
    return (
        <ScrollView
            testID="room-members"
            className="bg-sheet"
            contentContainerStyle={{ padding: 20, paddingBottom: 20 + insets.bottom, gap: 16 }}
        >
            <Text accessibilityRole="header" variant="headline">
                Members
            </Text>
            {members === null ? (
                <Text variant="subheadline" tone="muted">
                    The room’s members show once you’re online.
                </Text>
            ) : (
                <>
                    <Section title="People" rows={members.people} />
                    <Section title="Socios" rows={members.socios} />
                    <Button
                        variant="secondary"
                        label={members.manage.label}
                        onPress={() => openLink(members.manage.href)}
                        testID="room-members-manage"
                    />
                </>
            )}
        </ScrollView>
    );
}

function Section({ title, rows }: { title: string; rows: readonly MemberRow[] }) {
    if (rows.length === 0) {
        return null;
    }
    return (
        <View className="gap-1">
            <Text accessibilityRole="header" variant="footnote" weight="medium" tone="muted">
                {title}
            </Text>
            {rows.map((row) => (
                <View
                    key={row.id}
                    testID={`room-member-${row.id}`}
                    accessible
                    accessibilityLabel={row.detail === null ? row.name : `${row.name}, ${row.detail}`}
                    className="min-h-11 flex-row items-center gap-3 py-2"
                >
                    {row.person !== null ? <PersonAvatar mark={row.person} size={32} /> : null}
                    {row.socio !== null ? <SocioMark character={row.socio.character} size={32} /> : null}
                    <Text className="min-w-0 flex-1" numberOfLines={1}>
                        {row.name}
                    </Text>
                    {row.detail === null ? null : (
                        <Text variant="footnote" tone="muted">
                            {row.detail}
                        </Text>
                    )}
                </View>
            ))}
        </View>
    );
}
