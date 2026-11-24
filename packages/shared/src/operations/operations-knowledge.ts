import type { OpsAnswer, OpsPoint } from './operations.js';

/**
 * Operations → Knowledge and Capabilities (CB-191): Space pages, search,
 * dataset access, storage and quotas, and what socios can do. Shared by
 * the server's answers and the dashboard's pages.
 */

/** A live page counts as stale when nobody edited or used it this long. */
export const OPS_STALE_DAYS = 90;

/** One Space's pages: how many, how long, edited and stale. */
export interface OpsSpaceRow {
    spaceId: string;
    /** Null for a Space the dimensions don't hold (deleted since). */
    name: string | null;
    /** Live pages now. */
    pages: number;
    /** Their text, in characters of Markdown. */
    chars: number;
    /** Pages created in the range. */
    created: number;
    /** Edits in the range (page revisions kept). */
    edits: number;
    /** Live pages nobody edited or used for `OPS_STALE_DAYS` before the range's end. */
    stale: number;
}

export interface OpsSearchStats {
    queries: number;
    /** Searches that found nothing, after any correction. */
    empty: number;
    corrected: number;
    /** Searches the trigram index filled in. */
    trigram: number;
    /** Milliseconds, from the daily histograms merged (within about 9%). */
    p50: number | null;
    p95: number | null;
    maxMs: number | null;
    /** Each UTC day in the range with searches, oldest first. */
    days: { at: number; queries: number; empty: number }[];
}

/** Dataset access in the range (`data_audit`), counts only. */
export interface OpsDataAccess {
    total: number;
    denied: number;
    errors: number;
    /** Datasets touched. */
    datasets: number;
    /** Chats socios' tools touched them in (CB-194). */
    chats: number;
    /** By action and outcome, most first. */
    actions: { action: string; outcome: string; count: number }[];
    /** By who acted: a person, a socio, a token or the system. */
    actors: { kind: string; count: number }[];
}

export interface OpsKnowledge {
    /** Most pages first. */
    spaces: OpsSpaceRow[];
    /** Over every Space the filters keep; `editors` is distinct authors. */
    totals: Omit<OpsSpaceRow, 'spaceId' | 'name'> & { editors: number };
    search: OpsSearchStats;
    access: OpsDataAccess;
}
export interface OpsKnowledgeView extends OpsAnswer {
    /** Null while analytics has no answer. */
    knowledge: OpsKnowledge | null;
}

/** A page in the drill-down: least recently active first. */
export interface OpsPageRow {
    pageId: string;
    spaceId: string;
    spaceName: string | null;
    title: string;
    chars: number;
    revision: number;
    /** Edits in the range. */
    edits: number;
    createdAt: number;
    updatedAt: number;
    /** When a person last opened it from a search or a socio read it for them. */
    usedAt: number | null;
    /** The later of `updatedAt` and `usedAt`: what staleness is measured by. */
    activeAt: number;
    stale: boolean;
}

/** A dataset in the drill-down: largest first. */
export interface OpsDatasetRow {
    datasetId: string;
    name: string;
    /** A socio's scratch dataset. */
    scratch: boolean;
    sizeBytes: number;
    historyBytes: number;
    tables: number;
    createdAt: number;
    updatedAt: number;
    /** Access in the range. */
    accesses: number;
    denied: number;
    lastAccessAt: number | null;
}

export const OPS_STORAGE_KINDS = ['datasets', 'history', 'files', 'attachments', 'apps'] as const;
export type OpsStorageKind = (typeof OPS_STORAGE_KINDS)[number];
export const OPS_STORAGE_LABELS: Record<OpsStorageKind, string> = {
    datasets: 'Datasets',
    history: 'Dataset row history',
    files: 'Files',
    attachments: 'Chat attachments',
    apps: 'App versions',
};

/** What one kind holds now: live, and deleted but kept (CB-64). */
export interface OpsStorageNow {
    kind: OpsStorageKind;
    items: number;
    bytes: number;
    deletedItems: number;
    deletedBytes: number;
}

export interface OpsStorage {
    kinds: OpsStorageNow[];
    /** The app's database file, as last measured; null before the first. */
    database: {
        bytes: number;
        freeBytes: number;
        /** Chat history (`agent_runs`), measured at most hourly. */
        agentRunsBytes: number | null;
        measuredAt: number;
    } | null;
    /** Live bytes of each kind at the end of each bucket of the range. */
    series: { kind: OpsStorageKind; points: OpsPoint[] }[];
    /** Each person's data space use (live datasets and files), most first. */
    owners: { bytes: number; datasets: number }[];
    largestDatasetBytes: number;
    largestFileBytes: number;
}

/** A data space quota in force (`limitsInForce`) and how full it is. */
export interface OpsQuota {
    key: 'dataUserMaxMb' | 'dataDatasetMaxMb' | 'dataFileMaxMb' | 'dataMaxDatasets';
    label: string;
    /** In force: an admin's setting over the server's. */
    limit: number;
    unit: string;
    /** The fullest use, in the limit's unit; null while analytics has none. */
    highest: number | null;
    /** People at 80% or more of a per-person limit. */
    near: number | null;
    /** People at the limit. */
    at: number | null;
}

export interface OpsStorageView extends OpsAnswer {
    /** Null while analytics has no answer. */
    storage: OpsStorage | null;
    quotas: OpsQuota[];
}

/** A socio tool's calls in the range (`f_tool`). */
export interface OpsToolUse {
    tool: string;
    calls: number;
    /** Failed or timed out. */
    errors: number;
    refused: number;
}

/** One tool in the coverage matrix. */
export interface OpsCoverageTool {
    name: string;
    /** The module that gives it; null for one a capability declares but nothing gives here. */
    module: string | null;
    /** The registry entry that declares it; null is a gap. */
    capability: string | null;
    /** Given to a socio with every permission, in this deployment. */
    offered: boolean;
    calls: number;
    errors: number;
}
export interface OpsCoverageCapability {
    id: string;
    label: string;
    tools: number;
    offered: number;
    /** Approval capabilities its actions use. */
    approvals: string[];
}
export interface OpsCoverageModule {
    id: string;
    /** Tools it gives socios; 0: a feature socios have no tools for. */
    tools: number;
    /** False when its tools couldn't be listed outside a real turn. */
    listed: boolean;
}
export interface OpsCoverage {
    modules: OpsCoverageModule[];
    capabilities: OpsCoverageCapability[];
    tools: OpsCoverageTool[];
    /** Offered tools no registry entry declares. */
    unregistered: string[];
    /** Declared tools nothing gives in this deployment. */
    unoffered: string[];
}
export interface OpsCapabilitiesView extends OpsAnswer {
    coverage: OpsCoverage;
}

/** A capability socios asked for and lack (`dot_requests`), latest first. */
export interface OpsRequestRow {
    issueId: string;
    number: number | null;
    title: string | null;
    status: string | null;
    capability: string;
    createdAt: number;
    requesters: number;
    socios: number;
    people: number;
    lastAt: number;
}
