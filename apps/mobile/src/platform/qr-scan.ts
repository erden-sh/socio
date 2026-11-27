import Constants from 'expo-constants';

import { deviceLinkConfig } from '../net/add-device';

import { BUILD_VARIANT } from './variant';

// The QR scanner's link config (CB-566): this build's link host and variant from its embedded
// config, the same one root-navigation.tsx's link handlers read, so a scan opens exactly the links
// a tap from outside opens.

export const SCAN_LINKS = deviceLinkConfig(Constants.expoConfig?.extra, BUILD_VARIANT);
