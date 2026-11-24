/**
 * The docs catalog's layers: the compiled documentation behind the `Docs` tag.
 * Only the composition and tests import this file.
 *
 * The catalog needs no other feature's tag and no config (`content/docs`
 * under the working directory), and it holds nothing to release, so it has
 * no finalizer. Today the process compiles it in its boot step
 * (`composition/lifecycle/docs.ts`, phase 4, after the graph is built) and
 * hands it to `Ports.docs`; `DocsLive` offers that very catalog, and
 * `DocsCatalogLive` compiles it when a graph that holds `Docs` is built.
 */
import { Effect, Layer } from 'effect';

import { getDocsCatalog } from './catalog.js';
import { Docs, type DocsCatalogShape } from './contract.js';

/**
 * The process's catalog, compiled once (`getDocsCatalog` shares it). A
 * content tree that breaks the startup checks rejects with its plain
 * `Docs: ...` error, which this keeps as it is (a defect), as the boot step
 * throws it today.
 */
export const loadDocsCatalog: Effect.Effect<DocsCatalogShape> = Effect.promise(() => getDocsCatalog());

/** `Docs` over a catalog already compiled: the same object, not a copy. */
export const DocsLive = (catalog: DocsCatalogShape) => Layer.succeed(Docs, catalog);

/** `Docs`, compiling the process's catalog when the layer is built. */
export const DocsCatalogLive = Layer.effect(Docs, loadDocsCatalog);
