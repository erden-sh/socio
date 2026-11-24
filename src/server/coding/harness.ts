import { claudeCodeHarness } from './claude-code.js';
import { codexHarness } from './codex.js';
import { geminiCliHarness } from './gemini-cli.js';
import { grokHarness } from './grok.js';
import type { CodingHarness } from './harness-port.js';
import { opencodeHarness } from './opencode.js';

/**
 * The coding harnesses this build has, and the switch that turns them off
 * (CB-326). The port each adapter implements is `harness-port.ts`; its
 * types are re-exported here, where callers have always found them.
 */
export type {
    CodingHarness,
    CredentialShape,
    HarnessOutput,
    HarnessRun,
    HarnessTerms,
    ModelRoute,
} from './harness-port.js';

/** The harness of every session that recorded none (all from before CB-326). */
export const DEFAULT_HARNESS = 'opencode';

const HARNESS_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The harnesses this build knows, by id. */
export class HarnessRegistry {
    private byId = new Map<string, CodingHarness>();
    constructor(harnesses: readonly CodingHarness[] = []) {
        for (const harness of harnesses) {
            this.register(harness);
        }
    }
    register(harness: CodingHarness) {
        if (!HARNESS_ID.test(harness.id)) {
            throw new Error(`"${harness.id}" isn’t a harness id (lowercase letters, digits and dashes).`);
        }
        if (this.byId.has(harness.id)) {
            throw new Error(`The harness "${harness.id}" is registered already.`);
        }
        this.byId.set(harness.id, harness);
        return this;
    }
    get(id: string): CodingHarness | undefined {
        return this.byId.get(id);
    }
    has(id: string) {
        return this.byId.has(id);
    }
    list(): CodingHarness[] {
        return [...this.byId.values()];
    }
}

/** This build's harnesses, OpenCode first (the default). */
export const codingHarnesses = () =>
    new HarnessRegistry([opencodeHarness, codexHarness, claudeCodeHarness, geminiCliHarness, grokHarness]);

/**
 * `CODING_HARNESSES_DISABLED`: comma-separated harness ids that may not
 * start new sessions (a kill switch), empty by default. Ids this build
 * doesn't know are kept (a release may add the harness later); a malformed
 * entry fails at start, as other `CODING_*` settings do.
 */
export function parseDisabledHarnesses(value: string | undefined): string[] {
    const ids = (value ?? '')
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean);
    for (const id of ids) {
        if (!HARNESS_ID.test(id)) {
            throw new Error('CODING_HARNESSES_DISABLED must be harness ids separated by commas, such as "opencode".');
        }
    }
    return [...new Set(ids)];
}
