import { fetch } from 'expo/fetch';

import { type FetchFunction, noStore } from '../net/fetch-function';

// The app's one fetch: expo/fetch, bound
// here and nowhere else in src/ (the root lint bans the global fetch and
// expo/fetch everywhere but this file). src/net takes it as a parameter, so its
// Node tests hand in a fake; workspace requests go through authedFetch, and the
// address probe and logos through publicFetch, never through this directly.
// Every request asks for no-store (`noStore`, CB-356), so Android's HTTP
// cache keeps no answer; on iOS, socio-device leaves URLSession no cache. The annotation checks that expo/fetch fits the
// signature src/net expects.
export const appFetch: FetchFunction = noStore(fetch);
