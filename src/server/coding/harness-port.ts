import type { ExecRequest, SocioIdentity } from './supervisor.js';

/**
 * The coding harness port (CB-326): what a coding session needs
 * from the coding agent it runs, so sessions.ts doesn't name one. OpenCode
 * (opencode.ts) was the first adapter; Codex (codex.ts), Claude Code
 * (claude-code.ts), Gemini CLI (gemini-cli.ts) and Grok Build (grok.ts)
 * joined on the gateway route. The subscription route is not built yet.
 *
 * The app never sends the sandbox an argv: the supervisor builds the
 * process from a named exec and its checked parameters
 * (deployment/computers/coding-sandbox.mjs). So `command` answers the
 * supervisor exec that starts or continues a run, and the argv stays the
 * supervisor's, behind its own validation.
 */

/** What a harness needs to start or continue one prompt run. */
export interface HarnessRun {
    /** The harness's own session id to continue (`coding_sessions.opencodeSession`). */
    session: string;
    /** The gateway model name. */
    model: string;
    /** The prompt, sent on stdin, never argv or the environment. */
    prompt: string;
    /** The run's limit, in seconds. */
    seconds: number;
    /** The socio's commit identity. */
    identity: SocioIdentity;
    /** The person's own plan the session runs on, if any. */
    plan?: string | null;
}

/** A run's output, read: untrusted, inert and redacted. */
export interface HarnessOutput {
    progress: string[];
    /** The last assistant text, or the last error. */
    summary: string;
    /** The harness's session it ran in, when it said. */
    sessionId?: string;
    /** Whether it reported an error. */
    errored: boolean;
}

/** Where a subscription harness reads its login from; none use it yet. */
export interface CredentialShape {
    files: { path: string; format: 'json' | 'text' | 'env' }[];
}

export type ModelRoute = 'gateway' | 'subscription';

/**
 * The terms record of a harness, shown to admins in Settings → Coding: the
 * plan types the integration is built for, when its terms were last
 * checked (`YYYY-MM-DD`, or null until someone has), and where they are.
 */
export interface HarnessTerms {
    plans: string;
    checkedAt: string | null;
    url: string;
}

export interface CodingHarness {
    /** A stable id: what sessions record and `CODING_HARNESSES_DISABLED` names. */
    readonly id: string;
    /** Its name for people. */
    readonly label: string;
    /** The sandbox image that provides the CLI, and the file pinning its version. */
    readonly image: { name: string; pin: string };
    /** How it reaches a model: Socio's gateway, or a subscription directly. */
    readonly modelRoute: ModelRoute;
    /** Whether a session on a person's own plan may run it. */
    readonly personalPlans: boolean;
    /** Its terms record. */
    readonly terms: HarnessTerms;
    /** The supervisor exec that starts or continues a run. */
    command(run: HarnessRun): Extract<ExecRequest, { kind: 'prompt' }>;
    /** Reads its stdout so far into progress, summary and a session id. */
    read(stdout: string): HarnessOutput;
    /** The credential files it reads, for the subscription route. */
    readonly credential?: CredentialShape;
}
