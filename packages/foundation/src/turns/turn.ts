/**
 * The turn vocabulary: one Dot turn as the tools and hooks of every feature
 * see it, and the computer hooks a turn gets. Types only, server-only.
 */
import type { RunRefRecorder } from '@socio/shared/runs/run-refs';
import type { TraceEntry } from '@socio/shared/runs/run-trace';
import type { Dot } from '@socio/shared/types';

import type { InferencePurpose } from './inference-purpose.js';

/**
 * What started a turn besides a person's message: the scheduled task (a
 * schedule, or a goal's schedule) whose run it is. Set by the server.
 */
export interface TurnCause {
    kind: 'schedule';
    /** The task's id. */
    id: string;
}

/**
 * One Dot turn, as the tools a module contributes see it. `userId` is the
 * user the Dot acts for: the conversation's owner on the web and for
 * scheduled tasks, the linked sender on Telegram. Never taken from input.
 */
export interface DotTurn {
    dot: Dot;
    userId: string;
    threadId: string;
    /** A channel (Telegram) turn. */
    channel: boolean;
    purpose: InferencePurpose;
    /** A scheduled turn's task; absent for a person's message. */
    cause?: TurnCause;
    /**
     * The text of the person's newest message, as the conversation holds it
     * (attachments by name only), in a chat turn they started; absent for a
     * scheduled, job or voice turn, an approval's continuation, or
     * when the newest message is a note from the server. Untrusted: it may
     * hold pasted text.
     */
    said?: string;
    /** Throws once the turn must stop (paused, permissions changed, aborted). */
    check: () => void;
    signal: AbortSignal;
    /** Every tool name of this turn, once they are all assembled. */
    toolNames: () => readonly string[];
    /** The images this turn's model is shown at most (0: it has no vision). */
    maxImages?: number;
    /** Adds an entry to the turn's trace (CB-128); never throws. */
    trace?: (entry: TraceEntry) => void;
    /** The turn's run (`agent_runs.runId`), when it is one. */
    runId?: string;
    /**
     * Records what grounded the turn (CB-194): a page, search result,
     * dataset or recalled part of the chat its tools read. References
     * only; never throws.
     */
    ref?: RunRefRecorder;
}

/** The turn a message resolution is for (`DotExtensions.messages`). */
export interface MessageTurn {
    userId: string;
    dotId: string;
    threadId: string;
    maxImages: number;
    signal: AbortSignal;
}

/**
 * Hooks a computer exec gets from the platform: the data space's scoped
 * token for that command, written to the computer and exported for the
 * command, and the secrets to redact from what comes back.
 */
export interface ComputerExecEnv {
    /**
     * A file the platform writes in the computer's workspace first, under
     * `.socio/` (which the file tools refuse); the prefix deletes it.
     */
    file: { path: string; contents: string };
    /** Prepended to the command (sources the file); holds no secret. */
    prefix: string;
    /** Redacted from every response of this action. */
    secrets: string[];
    /** Called once the command has returned or failed: ends its token. */
    release?: () => void;
}
export interface ComputerHooks {
    /** The env for one command that may run for `runMs`. */
    execEnv?: (dotId: string, userId: string | undefined, runMs: number) => ComputerExecEnv | undefined;
    /** The Dot's computer stopped, or was found stopped: end its sessions. */
    stopped?: (dotId: string) => void;
    /** More secrets the computer holds, redacted from every action's response. */
    secrets?: (dotId: string) => readonly string[];
}
