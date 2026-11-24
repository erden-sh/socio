import Constants from 'expo-constants';

import { variantFromConfig } from '../navigation/linking';

// This build's variant (development, preview or production), from the config
// embedded in it (navigation/linking.ts reads `extra.variant`).
export const BUILD_VARIANT = variantFromConfig(Constants.expoConfig);
