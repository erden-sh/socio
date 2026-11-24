/** The docs catalog's boot step, where the process entry loaded it. */
import { Context } from 'effect';

import { getDocsCatalog } from '../../docs/catalog.js';
import type { DocsCatalogShape } from '../../docs/contract.js';
import type { AppEdge } from '../../main.js';
import { Ports } from '../ports.js';

/**
 * Compiles the catalog and fills the `docs` port, which the graph's `Docs`
 * (`composition/docs.ts`) and the connected agents' MCP endpoint read.
 * `compile` is the catalog's build; tests hand a fake one.
 */
export async function loadDocs(edge: AppEdge, compile: () => Promise<DocsCatalogShape> = getDocsCatalog) {
    const docs = await compile();
    Context.get(edge.services, Ports).docs.fill(docs);
    return docs;
}

/** The docs' step, as lifecycle/index.ts runs it: the catalog's load. */
export const docsLifecycle = { load: loadDocs };
