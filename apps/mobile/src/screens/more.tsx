import { useNavigation } from '@react-navigation/native';
import { View } from 'react-native';

import type { Role } from '@socio/shared/types';

import { useCollections, useHasWorkspaceScope, useLiveQuery, useUnsent } from '../live';
import { moreItemAction, moreRows } from '../navigation/tabs';
import { shellQuery, shellRows } from '../shell/queries';
import { unsentBadge } from '../shell/unsent';
import { useScheme } from '../theme/scheme';
import { colorsOf } from '../theme/theme';
import { AppSymbol, Screen, Squircle, ToneTile } from '../ui';

import { MODULE_ICONS } from './module-icons';
import { CountBadge, ListRow, Section, useRememberScreen } from './shell-parts';
import { TAB_ROOT_KEYBOARD, TAB_STACK_EDGES } from './tab-edges';

// The More tab: the account sheet, and the modules with no tab of
// their own (tabs.ts, MORE_ITEMS), each pushed as a page that shows where it
// lives until its screens come. Learning reads Skills for members.

export function MoreScreen() {
    return useHasWorkspaceScope() ? <More /> : <MorePage role={null} account={false} />;
}

function More() {
    const collections = useCollections();
    useRememberScreen('More');
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const unsent = unsentBadge(useUnsent().writes.length);
    return <MorePage role={shellRows(shell).workspace?.user.role ?? null} account unsent={unsent} />;
}

/** `unsent` is the Account row's badge: the Unsent list's count, or null. */
function MorePage(props: { role: Role | null; account: boolean; unsent?: string | null }) {
    const navigation = useNavigation();
    const rows = moreRows(props.role);
    const colors = colorsOf(useScheme());
    return (
        <Screen testID="more-screen" edges={TAB_STACK_EDGES} keyboardAware={TAB_ROOT_KEYBOARD}>
            {props.account ? (
                <Section title="Account">
                    <ListRow
                        first
                        testID="more-account"
                        leadingSize={44}
                        leading={
                            // A 44 pt squircle like the module tiles below, so the titles line up.
                            <Squircle size={44} color={colors.muted}>
                                <AppSymbol name="circle-user-round" size={22} color="muted-foreground" />
                            </Squircle>
                        }
                        title="Account"
                        trailing={
                            <View className="flex-row items-center gap-2">
                                {props.unsent ? <CountBadge label={props.unsent} /> : null}
                                <AppSymbol name="chevron-right" color="muted-foreground" />
                            </View>
                        }
                        accessibilityLabel={props.unsent ? `Account, ${props.unsent} unsent` : 'Account'}
                        onPress={() => navigation.navigate('Account')}
                    />
                </Section>
            ) : null}
            <Section title="Workspace" testID="more-items">
                {rows.map((row, index) => (
                    <ListRow
                        key={row.id}
                        first={index === 0}
                        testID={`more-${row.id}`}
                        leadingSize={44}
                        leading={<ToneTile tone={row.tone} icon={MODULE_ICONS[row.icon]} surface="card" />}
                        title={row.label}
                        trailing={<AppSymbol name="chevron-right" color="muted-foreground" />}
                        accessibilityLabel={row.label}
                        onPress={() => navigation.dispatch(moreItemAction(row.id, row.label))}
                    />
                ))}
            </Section>
        </Screen>
    );
}
