import * as AppleAuthentication from 'expo-apple-authentication';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import type { SocialProvider } from '@socio/shared/device-sign-in';

import { continueWith } from '../net/social-copy';
import { useScheme } from '../theme/scheme';
import { Text } from '../ui';
import { cx } from '../ui/cx';

// The Google and Apple buttons (CB-570), drawn as each asks: on iOS Apple's own button
// (expo-apple-authentication's ASAuthorizationAppleIDButton, "Continue with Apple", black in light,
// white in dark), and Google's "Continue with Google" with its G, on Google's light or dark fill
// (Google's sign-in branding). Each says busy while its sign-in runs; the others wait.

/** Apple's button is drawn natively at a fixed height; 50 pt is Apple's own. */
const APPLE_HEIGHT = 50;

/** Google's G, in its four colors (Google's sign-in branding). */
function GoogleMark() {
    return (
        <Svg width={18} height={18} viewBox="0 0 48 48" accessibilityElementsHidden importantForAccessibility="no">
            <Path
                fill="#EA4335"
                d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
            />
            <Path
                fill="#4285F4"
                d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
            />
            <Path
                fill="#FBBC05"
                d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
            />
            <Path
                fill="#34A853"
                d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
            />
        </Svg>
    );
}

/** Google's fill, outline and words, light and dark (its branding's neutral button). */
const GOOGLE_LOOK = {
    light: { background: '#FFFFFF', border: '#747775', words: '#1F1F1F' },
    dark: { background: '#131314', border: '#8E918F', words: '#E3E3E3' },
} as const;

function GoogleButton({ onPress, busy, disabled }: { onPress: () => void; busy: boolean; disabled: boolean }) {
    const look = GOOGLE_LOOK[useScheme()];
    const inactive = busy || disabled;
    return (
        <Pressable
            testID="sign-in-google"
            accessibilityRole="button"
            accessibilityLabel={continueWith('google')}
            accessibilityState={{ disabled: inactive, busy }}
            disabled={inactive}
            onPress={onPress}
            android_ripple={Platform.OS === 'ios' ? undefined : { borderless: false, foreground: true }}
            className={cx(
                'min-h-11 flex-row items-center justify-center gap-3 self-stretch overflow-hidden rounded-full border px-5 py-2',
            )}
            style={({ pressed }) => [
                { backgroundColor: look.background, borderColor: look.border },
                Platform.OS === 'ios' && pressed ? { opacity: 0.7 } : null,
                inactive && !busy ? { opacity: 0.5 } : null,
            ]}
        >
            {busy ? <ActivityIndicator size="small" color={look.words} /> : <GoogleMark />}
            <Text variant="button" className="shrink text-center" style={{ color: look.words }}>
                {continueWith('google')}
            </Text>
        </Pressable>
    );
}

function AppleButton({ onPress, busy, disabled }: { onPress: () => void; busy: boolean; disabled: boolean }) {
    const scheme = useScheme();
    const inactive = busy || disabled;
    return (
        <View
            // The testID is the wrapper's: Apple's native button keeps its own identifier.
            testID="sign-in-apple"
            className="self-stretch"
            style={{ opacity: inactive && !busy ? 0.5 : 1 }}
            pointerEvents={inactive ? 'none' : 'auto'}
            accessibilityState={{ disabled: inactive, busy }}
        >
            <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                buttonStyle={
                    scheme === 'dark'
                        ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                        : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                }
                cornerRadius={APPLE_HEIGHT / 2}
                style={{ height: APPLE_HEIGHT }}
                onPress={onPress}
            />
            {busy ? (
                <View className="absolute inset-0 items-end justify-center pr-5" pointerEvents="none">
                    <ActivityIndicator size="small" color={scheme === 'dark' ? '#000000' : '#FFFFFF'} />
                </View>
            ) : null}
        </View>
    );
}

/** The buttons for `providers`, in order; `busy` is the one whose sign-in runs. */
export function SocialButtons({
    providers,
    busy,
    disabled,
    onPress,
}: {
    readonly providers: readonly SocialProvider[];
    readonly busy: SocialProvider | null;
    readonly disabled: boolean;
    readonly onPress: (provider: SocialProvider) => void;
}) {
    if (providers.length === 0) {
        return null;
    }
    return (
        <View className="gap-3 self-stretch" testID="sign-in-social">
            {providers.map((provider) =>
                provider === 'apple' && Platform.OS === 'ios' ? (
                    <AppleButton
                        key={provider}
                        onPress={() => onPress(provider)}
                        busy={busy === provider}
                        disabled={disabled || (busy !== null && busy !== provider)}
                    />
                ) : provider === 'google' ? (
                    <GoogleButton
                        key={provider}
                        onPress={() => onPress(provider)}
                        busy={busy === provider}
                        disabled={disabled || (busy !== null && busy !== provider)}
                    />
                ) : null,
            )}
        </View>
    );
}
