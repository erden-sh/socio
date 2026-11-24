/**
 * The docs catalog's construction: the `Docs` tag in the graph, over the
 * catalog the boot step compiles after the graph is built (`lifecycle/docs.ts`,
 * phase 4), as before.
 *
 * Compiling it in the graph (`DocsCatalogLive`) would move the catalog's
 * startup checks ahead of the boot steps of phase 3 (backups, Telegram,
 * the task runner, the leader lease): a broken docs tree would then stop
 * the boot earlier than it does. So the graph's `Docs` reads the catalog
 * the boot step fills (`ports.docs`) at each call, as the Telegram channel
 * and backups are set late; a call before phase 4 throws.
 */
import { Effect, Layer } from 'effect';

import { Docs, type DocsCatalogShape } from '../docs/contract.js';

import { Ports, type LatePort } from './ports.js';

/** `Docs` over the catalog in `port`, read at each call. */
export function docsOver(port: LatePort<DocsCatalogShape>): DocsCatalogShape {
    const catalog = () => {
        const filled = port.peek();
        if (!filled) {
            throw new Error('Docs: the catalog is not loaded yet.');
        }
        return filled;
    };
    return {
        get digest() {
            return catalog().digest;
        },
        screen: (url, role) => catalog().screen(url, role),
        tree: (role) => catalog().tree(role),
        list: (role) => catalog().list(role),
        markdown: (url, role) => catalog().markdown(url, role),
        llms: (full, role) => catalog().llms(full, role),
        search: (query, role) => catalog().search(query, role),
    };
}

/** The docs' step of the graph, near its end: `Docs`, over the catalog filled at boot. It builds nothing. */
export const docsLayers = {
    bridges: Layer.effect(
        Docs,
        Effect.gen(function* () {
            return Docs.of(docsOver((yield* Ports).docs));
        }),
    ),
};
