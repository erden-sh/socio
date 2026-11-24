import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { openAuthTab } from '../../modules/socio-device';
import { openSheet, sheetConfig, type SheetResult } from '../net/auth-sheet';

// The system sign-in sheet's binding: the build's sheet config from its embedded config, and the
// platform's two sheets (src/net/auth-sheet.ts says which runs when). Sheet sign-in goes through it
// (sheet-sign-in.ts).

/** This build's sheet config, or null when it has none (a preview or production Personal Team build). */
export const SHEET_CONFIG = sheetConfig(Constants.expoConfig);

/** Opens `url` (the workspace's device start page) in the system sign-in sheet. Never throws. */
export function openAuthSheet(url: string): Promise<SheetResult> {
    return openSheet(url, SHEET_CONFIG, {
        os: Platform.OS === 'ios' ? 'ios' : 'android',
        openAuthSession: (start, callback, options) => WebBrowser.openAuthSessionAsync(start, callback, options),
        openAuthTab,
    });
}
