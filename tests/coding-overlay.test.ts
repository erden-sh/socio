import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';
import { parse } from 'yaml';

// CB-239: the app's side of the coding gateway as composed
// (.docker/compose.computers.yml, .docker/compose.computers-app.yml), checked as written.
// One variable, CODING_GATEWAY_SUBNET, is the subnet the app's gateway listener and the egress proxy's diagnostics port accept;
// the app reads denials at the proxy's diagnostics port
// (CODING_EGRESS_DIAGNOSTICS_URL); nothing here is deployed or run.

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
type Service = {
    environment?: Record<string, string>;
    networks?: Record<string, { aliases?: string[] } | null> | string[];
    [key: string]: unknown;
};
type Stack = {
    services: Record<string, Service>;
    networks?: Record<string, Record<string, unknown>>;
};
// Compose's `!reset` (an override file's way to drop a list) as what it leaves.
const reset = { tag: '!reset', collection: 'seq' as const, resolve: () => [] };
const yaml = (path: string) => parse(read(path), { customTags: [reset] }) as Stack;
const egressMain = read('src/coding-egress/main.ts');
const diagnosticsPort = /CODING_EGRESS_DIAGNOSTICS_PORT \?\? (\d+)/.exec(egressMain)![1];

it('gives compose one default subnet for the gateway network, the app and the proxy, and the diagnostics URL', () => {
    const computers = yaml('.docker/compose.computers.yml');
    const app = yaml('.docker/compose.computers-app.yml');
    const subnet = '${CODING_GATEWAY_SUBNET:-10.214.0.0/24}';
    expect(computers.networks!['coding-gateway']).toMatchObject({
        internal: true,
        ipam: { config: [{ subnet }] },
    });
    expect(computers.services['coding-egress']!.environment!.CODING_EGRESS_DIAGNOSTICS_SUBNET).toBe(subnet);
    const env = app.services.app!.environment!;
    expect(env.GATEWAY_SUBNET).toBe(subnet);
    const url = new URL(env.CODING_EGRESS_DIAGNOSTICS_URL!);
    expect(url.hostname).toBe('coding-egress');
    expect(url.port).toBe(diagnosticsPort);
    // The supervisor puts computers on the network the app joins.
    expect(app.services['computer-supervisor']!.environment!.COMPUTER_NETWORK).toBe(
        '${COMPUTER_NAMESPACE:-company-brain}-computers',
    );
    expect(app.networks!.computers).toMatchObject({ name: '${COMPUTER_NAMESPACE:-company-brain}-computers' });
    // Clear of the sandboxes' pool and the app browser's subnets.
    expect(subnet).not.toMatch(/10\.21[23]\./);
});
