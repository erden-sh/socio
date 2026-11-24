import { ActivityIndicator, Pressable, View } from 'react-native';

import type { FirstScreenView, FirstScreenWay } from '../net/first-screen';
import type { ToneName } from '../theme/theme';
import { AppSymbol, Text, ToneTile } from '../ui';
import { cx } from '../ui/cx';
import type { SymbolName } from '../ui/symbols';

import { WorkspaceHost } from './workspace-host';

// Add workspace's first screen's parts: the ways in, one card of rows in their tones (only
// the address is a button: the invite and the QR code happen outside the app), and a Get the app
// link's card, its host through WorkspaceHost with what is happening to it. Rows grow with their
// text; the rules between them are the rows' own top borders.

const WAY_LOOK: Record<FirstScreenWay['id'], { readonly icon: SymbolName; readonly tone: ToneName }> = {
    invite: { icon: 'mail', tone: 'sky' },
    qr: { icon: 'qr-code', tone: 'violet' },
    address: { icon: 'globe', tone: 'emerald' },
};

function WayRow({ way, first, onPress }: { way: FirstScreenWay; first: boolean; onPress: () => void }) {
    const look = WAY_LOOK[way.id];
    const body = (
        <>
            <ToneTile tone={look.tone} icon={look.icon} surface="card" />
            <View className="min-w-0 flex-1 gap-0.5">
                <Text weight="medium">{way.title}</Text>
                <Text variant="subheadline" tone="muted">
                    {way.detail}
                </Text>
            </View>
        </>
    );
    if (!way.pressable) {
        return (
            <View
                testID={way.testID}
                accessible
                accessibilityLabel={`${way.title}. ${way.detail}`}
                className={cx('flex-row items-center gap-3 p-3', !first && 'border-t border-border')}
            >
                {body}
            </View>
        );
    }
    return (
        <Pressable
            testID={way.testID}
            accessibilityRole="button"
            accessibilityLabel={way.title}
            accessibilityHint={way.detail}
            onPress={onPress}
            className={cx('flex-row items-center gap-3 p-3 active:bg-accent', !first && 'border-t border-border')}
            style={{ minHeight: 56 }}
        >
            {body}
            <AppSymbol name="chevron-right" color="muted-foreground" />
        </Pressable>
    );
}

export function FirstScreenWays({ ways, onAddress }: { ways: FirstScreenView['ways']; onAddress: () => void }) {
    return (
        <View
            testID="first-screen-ways"
            className="self-stretch overflow-hidden rounded-xl border border-border bg-card"
        >
            {ways.map((way, index) => (
                <WayRow key={way.id} way={way} first={index === 0} onPress={onAddress} />
            ))}
        </View>
    );
}

export function LinkCard({ link }: { link: NonNullable<FirstScreenView['link']> }) {
    return (
        <View
            testID="first-screen-link"
            accessibilityLiveRegion="polite"
            className="items-center gap-2 self-stretch rounded-xl border border-border bg-card p-4"
        >
            <WorkspaceHost host={link.host} testID="first-screen-link-host" />
            <View className="flex-row items-center gap-2">
                {link.busy ? <ActivityIndicator testID="first-screen-link-busy" /> : null}
                <Text
                    tone={link.busy ? 'muted' : 'destructive'}
                    className="text-center"
                    testID="first-screen-link-line"
                >
                    {link.line}
                </Text>
            </View>
            {link.detail === null ? null : (
                <Text variant="footnote" tone="muted" testID="probe-detail">
                    {link.detail}
                </Text>
            )}
        </View>
    );
}
