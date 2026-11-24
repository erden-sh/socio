import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { Platform, type StyleProp, View, type ViewStyle } from 'react-native';

import { cx } from './cx';

// A surface in Liquid Glass where the system has it: on iOS 26 and later
// (`isLiquidGlassAvailable()`), expo-glass-effect's GlassView, which the
// system draws for the scheme it shows; below iOS 26 and on Android, the
// app's token surface given as `fallbackClassName`. Only for
// what floats over a page as Slack's do (Home's tiles and header buttons): the
// native tab bar and native-stack draw their own glass, and the app leaves
// those to the system.

/** Whether this phone draws Liquid Glass: iOS 26 and later. */
export const hasLiquidGlass = () => Platform.OS === 'ios' && isLiquidGlassAvailable();

export interface GlassSurfaceProps {
    readonly children?: ReactNode;
    /** The token surface without glass: its background, border and radius. */
    readonly fallbackClassName: string;
    /** Layout classes for both: padding, gap, direction. */
    readonly className?: string;
    /** Its corner radius in points, which the glass needs as a style. */
    readonly radius: number;
    readonly style?: StyleProp<ViewStyle>;
    /** The glass reacts to touch (a button). */
    readonly interactive?: boolean;
    readonly testID?: string;
}

export function GlassSurface({ fallbackClassName, className, ...props }: GlassSurfaceProps) {
    if (hasLiquidGlass()) {
        return (
            <GlassView
                testID={props.testID}
                glassEffectStyle="regular"
                isInteractive={props.interactive === true}
                style={[{ borderRadius: props.radius, overflow: 'hidden' }, props.style]}
            >
                <View className={className}>{props.children}</View>
            </GlassView>
        );
    }
    return (
        <View
            testID={props.testID}
            className={cx(fallbackClassName, className)}
            style={[{ borderRadius: props.radius }, props.style]}
        >
            {props.children}
        </View>
    );
}
