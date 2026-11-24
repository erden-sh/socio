// crypto.getRandomValues for Hermes, first, before any other module runs: the
// store's keys come from it (src/platform/crypto.ts), and TanStack DB (the
// workspace scope's collections and live queries, src/sync and src/live)
// makes ids with it.
import 'react-native-get-random-values';
import { registerRootComponent } from 'expo';

import { App } from './src/app';

registerRootComponent(App);
