import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { userAgent } from '../net/user-agent';

// The app's User-Agent (src/net/user-agent.ts) from this build and this phone:
// the app's version from the embedded config, the platform, and the OS's
// version (Android's release, `16`, not its API level, which Platform.Version
// holds there). src/net gets the string, never React Native.
export const APP_USER_AGENT = userAgent({
    appVersion: Constants.expoConfig?.version ?? '0.0.0',
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    osVersion: Platform.OS === 'android' ? Platform.constants.Release : String(Platform.Version),
    tablet: Platform.OS === 'ios' && Platform.isPad,
});
