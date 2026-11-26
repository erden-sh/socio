import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ActiveWorkspace } from './live/active-scope';
import { externalLinks, RootNavigation } from './navigation/root-navigation';
import { activeScope } from './platform/active-scope';
import { launchStatus, startLaunch } from './platform/device-store';
import { setTapOpener } from './platform/push-taps';
import { signOutStatus } from './platform/sign-out';
import { BuildNoticeLayer } from './screens/build-notice';
import { ClientUpdateGate } from './screens/client-update';
import { PresenceLayer } from './screens/notice-banner';
import { SigningOut } from './screens/signing-out';
import { TapNoticeLayer } from './screens/tap-notice';
import { WorkspaceFailed } from './screens/workspace-failed';
import { WorkspaceSummary } from './screens/workspace-summary';
import { applySystemColors } from './theme/native-colors';
import { navigationTheme } from './theme/navigation-theme';
import { useScheme } from './theme/scheme';
import { SystemBars } from './theme/system-bars';
import { Banner, Button, Screen, Text } from './ui';

import '../global.css';

// The app's root: providers around the root stack. Screens, their paths and
// presets are added in navigation/routes.ts and navigation/root-stack.tsx,
// never here. global.css gives every component its class names (uniwind), in
// the system's scheme, which the navigation theme and the system bars follow.
//
// The store opens before the first frame: the launch starts
// here, at import, and the splash stays up until it has opened and the root
// gate knows its state, with the active workspace's scope open: the root stack
// draws under it, keyed per scope, so a switch starts the tree again
// (live/active-scope.tsx); a scope that doesn't open shows why, with Try again,
// the other workspaces and Add a workspace (screens/workspace-failed.tsx). A
// store that doesn't open shows why, with Try again. While a sign-out wipes a
// workspace, screens/signing-out.tsx draws in place of the root stack, so the
// app navigates only once the wipe is verified (platform/sign-out.ts).
//
// The presence layer (screens/notice-banner.tsx) holds the root stack:
// touches there count as using the app, and the open workspace's in-app
// notices show over it, their links opening through externalLinks.
//
// A notification's tap opens its path through externalLinks too, and what it
// says ("Switched to Acme") shows over everything, outside the workspace's
// tree, which a switch mounts again (screens/tap-notice.tsx).
//
// Over everything, once after an install, the build notice says whether the
// build changed and which way (screens/build-notice.tsx).
//
// gesture-handler's root view holds everything, for the workspace drawer
// (navigation/shell-drawer.tsx).

const fonts = Platform.OS === 'ios' ? 'ios' : 'android';
const THEMES = { light: navigationTheme('light', fonts), dark: navigationTheme('dark', fonts) };

const { open: openAppPath } = externalLinks;
setTapOpener(openAppPath);

// iOS's neutral tokens are the system's colors, before anything draws.
applySystemColors();
SplashScreen.preventAutoHideAsync().catch(() => {});
startLaunch();

export function App() {
    const scheme = useScheme();
    const launch = useSyncExternalStore(launchStatus.subscribe, launchStatus.get);
    const signingOut = useSyncExternalStore(signOutStatus.subscribe, signOutStatus.get);
    const opening = launch.kind === 'opening';
    useEffect(() => {
        if (!opening) {
            SplashScreen.hide();
        }
    }, [opening]);
    if (opening) {
        return null;
    }
    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            {/* The keyboard's movement, for the chat's list and composer. */}
            <KeyboardProvider>
                <SafeAreaProvider>
                    {launch.kind !== 'open' ? (
                        <LaunchFailed />
                    ) : signingOut.kind !== 'idle' ? (
                        <SigningOut status={signingOut} />
                    ) : (
                        <ActiveWorkspace
                            source={activeScope}
                            failed={(workspaceId) => <WorkspaceFailed workspaceId={workspaceId} />}
                        >
                            <WorkspaceSummary />
                            {/* Update Socio in place of the workspace while its server needs a newer app (CB-553). */}
                            <ClientUpdateGate>
                                <PresenceLayer open={openAppPath}>
                                    <RootNavigation theme={THEMES[scheme]} />
                                </PresenceLayer>
                            </ClientUpdateGate>
                        </ActiveWorkspace>
                    )}
                    {/* A notification tap's "Switched to Acme". */}
                    <TapNoticeLayer />
                    {/* "Updated to build N" once after an install, over every screen (src/shell/build-info.ts). */}
                    <BuildNoticeLayer />
                    <SystemBars />
                </SafeAreaProvider>
            </KeyboardProvider>
        </GestureHandlerRootView>
    );
}

/** The store didn't open: nothing on the phone was deleted, and Try again opens it again. */
function LaunchFailed() {
    return (
        <Screen testID="launch-failed-screen" centered>
            <Text accessibilityRole="header" variant="heading" className="text-center">
                Socio couldn’t open
            </Text>
            <Banner tone="error">Your data on this phone couldn’t be read. Nothing was deleted.</Banner>
            <Button label="Try again" icon="rotate-ccw" onPress={startLaunch} testID="launch-try-again" />
        </Screen>
    );
}
