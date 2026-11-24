import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

import type { NetworkSource, NetworkState } from '../sync/triggers';

// The network for sync: NetInfo, bound here
// and nowhere else in src/ (tests/platform-bindings.test.ts), so src/sync,
// which runs under Node, takes it as a parameter and its tests hand in a fake.
// Its listener is called with the state soon after it subscribes, then with each
// change; src/sync/triggers.ts reads the network coming back, going, or changing
// type (Wi-Fi to cellular doesn't show as offline).

const networkState = (state: NetInfoState): NetworkState => ({ connected: state.isConnected, type: state.type });

export const network: NetworkSource = {
    current: async () => networkState(await NetInfo.fetch()),
    subscribe: (listener) => NetInfo.addEventListener((state) => listener(networkState(state))),
};
