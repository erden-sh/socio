import type { PluginDatasetAccess } from './plugins.js';

/**
 * Workspace-allocated plugin datasets (CB-451): what a
 * plugin's manifest needs, and which workspace dataset each need is bound
 * to (`data_plugin_bindings`). Shared by the server's plugin routes and
 * the admin screens that bind at install and on the plugin's page.
 */

/**
 * An admin's choice for one need: a new dataset (`write` needs only), an
 * existing workspace dataset by id, or `null` for **Not now** (`read`
 * needs only: the need stays unbound and the token doesn't cover it).
 */
export type PluginBindingChoice = 'new' | { datasetId: string } | null;
/** Choices by need name, as `POST /api/plugins/:id/install` takes them (`bindings`). */
export type PluginBindingChoices = Record<string, PluginBindingChoice>;

/** A workspace dataset an admin may bind a need to, with whether it fits. */
export interface PluginBindingCandidate {
    id: string;
    name: string;
    description: string;
    /** The plugin that writes it now, if any (a `write` need never binds to one). */
    writer?: { id: string; name: string };
    /** Why it can't be bound to this need; absent when it can. */
    problem?: string;
}

/** One need of a plugin's manifest, with its binding now and what it could be bound to. */
export interface PluginNeedPlan {
    need: string;
    access: PluginDatasetAccess;
    /** No `access` in the manifest: bound to a new dataset with no question, as before CB-451. */
    implicit: boolean;
    description: string;
    /** The tables and columns the need expects, for the admin to compare. */
    tables: Array<{ table: string; columns: Array<{ name: string; type: string }> }>;
    /** Its live binding, while the plugin is installed. */
    bound?: { datasetId: string; datasetName: string; boundBy: string; boundAt: number };
    /** The dataset its last binding named, when it ended (uninstall); offered preselected on reinstall. */
    previous?: { datasetId: string; datasetName: string };
    /** Existing workspace datasets, compatible or not (each says why not). */
    candidates: PluginBindingCandidate[];
    /** What the install screen preselects. */
    preselected: PluginBindingChoice;
}

/** `GET /api/plugins/:id/bindings`: every need of the plugin's manifest (installed, or the catalog's). */
export interface PluginBindingPlan {
    pluginId: string;
    installed: boolean;
    needs: PluginNeedPlan[];
}

/** One need in the token exchange's answer (`POST /api/workload/data-token`). */
export interface PluginTokenNeed {
    /** The need's name: what the plugin's data API calls use for it. */
    name: string;
    access: PluginDatasetAccess;
    /** The bound dataset's id. */
    id: string;
    /** The bound dataset's own name, which an admin may change. */
    datasetName: string;
    description: string;
}
