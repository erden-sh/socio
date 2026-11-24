import { useNavigation } from '@react-navigation/native';

import { formatTokens } from '@socio/shared/token-count';

import { routeInVariant } from '../navigation/routes';
import { BUILD_VARIANT } from '../platform/variant';
import type { ToneName } from '../theme/theme';
import { Button, Screen, Text, ToneTile } from '../ui';
import type { SymbolName } from '../ui/symbols';

// A screen that holds a route's place until its real screen lands. Its testID
// is the route's, and stays when the real screen replaces it, so the Maestro
// flows that look for it keep working. It is built from the primitives
// (src/ui), so whichever placeholder the gate shows draws the theme on the
// device: its tile is a lucide icon through react-native-svg in a module tone,
// its title the web's page heading (text-2xl, medium, tight).
//
// Its last line is computed by @socio/shared from its source (metro.config.js):
// token-count.ts and the locale.ts it imports, so it also proves the source
// mapping works on the device.
//
// In development and preview builds, a placeholder that asks for it offers the
// store's Diagnostics screen; production has no such route (routes.ts).

/** This build has the Diagnostics route. */
const HAS_DIAGNOSTICS = routeInVariant('Diagnostics', BUILD_VARIANT);

export function Placeholder(props: {
    testID: string;
    title: string;
    caption?: string;
    icon: SymbolName;
    tone: ToneName;
    /** Offers Diagnostics, in the builds that have it. */
    diagnostics?: boolean;
}) {
    const navigation = useNavigation();
    return (
        <Screen testID={props.testID} centered>
            <ToneTile tone={props.tone} icon={props.icon} />
            <Text accessibilityRole="header" variant="heading" className="text-center">
                {props.title}
            </Text>
            {props.caption === undefined ? null : (
                <Text variant="subheadline" tone="muted" className="text-center">
                    {props.caption}
                </Text>
            )}
            <Text variant="footnote" tone="muted" className="text-center">
                Shared code: formatTokens(1360000) = {formatTokens(1_360_000)}
            </Text>
            {props.diagnostics === true && HAS_DIAGNOSTICS ? (
                <Button
                    variant="ghost"
                    label="Diagnostics"
                    icon="stethoscope"
                    onPress={() => navigation.navigate('Diagnostics')}
                    testID="open-diagnostics"
                />
            ) : null}
        </Screen>
    );
}
