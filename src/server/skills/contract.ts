/**
 * What other features may know of chat skills (CB-143): the registry a
 * turn asks which skill a message invokes, the workspace's skills and the
 * skill each person has on in each chat, and `/compact`. Its tags, as
 * slices of the methods callers use, and the plain types they name. It
 * imports only `effect`, `@socio/*`, other contracts and (type only)
 * `@ag-ui/*` and `@tanstack/ai`, and holds no logic.
 *
 * The types here moved from the files that defined them
 * (`domain/repositories.ts`, `registry.ts`, `compact.ts`), which re-export
 * them, so every importer keeps compiling until that importer switches to the
 * contract. The pure helpers other features call moved to
 * `@socio/foundation/skills/*` (`chat-skill`: `ChatSkill`, `commandName`,
 * `helpText`, `skillNote`, `assertSkillsFit`; `skill-actions`:
 * `withoutSkillActions`); the feature logic (the registry, the repositories,
 * `/compact`) is behind the tags below.
 *
 * The `unfurl_link` and `unfurl_recursive` tool builders (`unfurl-tool.ts`,
 * `unfurl-recursive.ts`), which `web/web-module.ts` calls, are behind the
 * `UnfurlTools` tag: their options name a web reader's `read`
 * (`@socio/foundation/web/reads`, which web's `WebReader` offers) and
 * media's `MediaShape`; the page tools they read and write pages through
 * (`PageTools`) are bound when the tag is built (`services.ts`).
 *
 * `layer.ts` implements every tag here.
 *
 * Not here, on purpose:
 * - `chatSkillsModule`, `chatSkillRoutes`, the agent tools (`tools.ts`) and
 *   the GitHub importer: the module registry, route mounting and turn
 *   tools, all built from a `ModuleContext`; no other feature calls them.
 * - `skillsRepository(db)` and `skillSessions(db)`: construction (one
 *   repository per database), which the `WorkspaceSkills` and
 *   `SkillSessions` tags give built.
 * - A `SkillsConfig` tag: skills read no `PlatformConfig` field.
 */
import type { Message, RunAgentInput } from '@ag-ui/core';
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import type { AnyTextAdapter } from '@tanstack/ai';
import { Context } from 'effect';

import type { ChatSkill } from '@socio/foundation/skills/chat-skill';
import type { DotTurn } from '@socio/foundation/turns/turn';
import type { WebReadRequest, WebReadResult } from '@socio/foundation/web/reads';
import type { ChatSkillMode } from '@socio/shared/chat/chat-skills';

import type { FitOptions, TimeMarkersShape } from '../context/contract.js';
import type { MediaShape } from '../media/contract.js';

// ── Repositories (`domain/repositories.ts`) ──────────────────────────────

/*
 * Chat skills' repositories (CB-110): the workspace's own skills
 * with their revisions, and the skill each person has on in each chat. Only
 * `skills/infra` implements them; each write works inside or outside a unit
 * of work: outside one it opens its own.
 */

export interface WorkspaceSkill {
    id: string;
    name: string;
    description: string;
    instructions: string;
    mode: ChatSkillMode;
    revision: number;
    sha256: string;
    source: 'workspace' | 'git';
    sourceUrl: string | null;
    sourcePath: string | null;
    sourceRef: string | null;
    sourceCommit: string | null;
    sourceMetadata: string | null;
    createdAt: number;
    createdBy: string;
    updatedAt: number;
    updatedBy: string;
}

export interface SkillRevision {
    revision: number;
    description: string;
    instructions: string;
    mode: ChatSkillMode;
    sha256: string;
    restoredFrom: number | null;
    createdAt: number;
    createdBy: string;
    source: 'workspace' | 'git';
    sourceUrl: string | null;
    sourcePath: string | null;
    sourceRef: string | null;
    sourceCommit: string | null;
    sourceMetadata: string | null;
}

export interface SkillProvenance {
    url: string;
    path: string;
    ref: string;
    commit: string;
    sha256: string;
    license: string;
    licenseText: string;
    locallyModified?: boolean;
}

export type SkillContent = Pick<WorkspaceSkill, 'name' | 'description' | 'instructions' | 'mode'>;

export interface WorkspaceSkillsRepository {
    /** The live skills, by name, each at its current revision. */
    list(): Promise<WorkspaceSkill[]>;
    get(name: string): Promise<WorkspaceSkill | undefined>;
    /**
     * Adds the skill, or a revision of the live one of that name when its
     * content changed (the same content keeps the current revision).
     */
    save(skill: SkillContent, by: string, now?: number): Promise<WorkspaceSkill>;
    /** Imports exactly the reviewed revision, refusing a stale preview. */
    import(
        skill: SkillContent,
        source: SkillProvenance,
        expected: Pick<WorkspaceSkill, 'id' | 'revision' | 'sha256'> | null,
        by: string,
        now?: number,
    ): Promise<WorkspaceSkill>;
    /** Every revision of the live skill of that name, newest first. */
    revisions(name: string): Promise<SkillRevision[]>;
    /**
     * A new revision with an earlier one's content; undefined when there is
     * no such skill or revision.
     */
    rollback(name: string, revision: number, by: string, now?: number): Promise<WorkspaceSkill | undefined>;
    /** Hides the live skill of that name; false when there is none. */
    remove(name: string, by: string, now?: number): Promise<boolean>;
}

/** How a skill that was on in a chat ended. */
export type SessionEnd = 'done' | 'model' | 'replaced' | 'stopped' | 'removed';

export interface SkillSession {
    skill: string;
    startedAt: number;
    startedBy: string;
}

/** The `until-done` skill each person has on in each chat (`chat_skill_sessions`). */
export interface SkillSessionsRepository {
    /** The skill `person` has on in the chat. */
    active(threadId: string, person: string): Promise<SkillSession | undefined>;
    /**
     * Turns `skill` on in the chat for `person`, ending the one they had on
     * (`replaced`), in one transaction.
     */
    start(threadId: string, skill: string, person: string, now?: number): Promise<SkillSession>;
    /** Ends the skill `person` has on in the chat; the one ended, if any. */
    end(threadId: string, person: string, reason: SessionEnd, now?: number): Promise<SkillSession | undefined>;
}

/** The workspace's own skills (`skillsRepository(db)`). */
export class WorkspaceSkills extends Context.Service<WorkspaceSkills, WorkspaceSkillsRepository>()(
    'socio/skills/WorkspaceSkills',
) {}

/** The skill each person has on in each chat (`skillSessions(db)`). */
export class SkillSessions extends Context.Service<SkillSessions, SkillSessionsRepository>()(
    'socio/skills/SkillSessions',
) {}

// ── The registry (`registry.ts`) ─────────────────────────────────────────

/** A skill the person's newest message invoked, and their text after it. */
export interface Invocation {
    skill: ChatSkill;
    rest: string;
    /** Nothing but the skill's name: no text after it, no files. */
    bare: boolean;
    /**
     * The message is the input's last: the turn starts with it, rather than
     * carrying on after a tool's result (an approval, a page review).
     */
    latest: boolean;
}

/**
 * The chat skills a person can invoke: the built-in ones, then the
 * workspace's. `registry.ts`'s `ChatSkills` implements it (`chatSkills`
 * on the workspace's repositories).
 */
export interface SkillRegistryShape {
    /** Every skill: the built-in ones, then the workspace's, by name. */
    list(): Promise<ChatSkill[]>;
    /**
     * The skill a turn's input invokes: its person's newest message starts
     * with one's name. An action skill only when that message is the last.
     */
    invocation(messages: readonly Message[]): Promise<Invocation | undefined>;
    /**
     * The `until-done` skill `person` has on in a chat, with its current
     * content. One removed since it started is ended (`removed`).
     */
    active(threadId: string, person: string): Promise<{ skill: ChatSkill; session: SkillSession } | undefined>;
}

export class SkillRegistry extends Context.Service<SkillRegistry, SkillRegistryShape>()('socio/skills/SkillRegistry') {}

// ── `/compact` (`compact.ts`) ────────────────────────────────────────────

/** What `/compact` needs from the turn (CB-143). */
export interface CompactTurn {
    input: RunAgentInput;
    /** The conversation before the `/compact` message, as the turn got it. */
    messages: Message[];
    /** Attachment references as the model reads them (`DotExtensions.messages`). */
    resolve?: (messages: Message[]) => Promise<Message[]>;
    maxImages: number;
    markers: TimeMarkersShape;
    /** The chat's model, which writes the notes unless `fit.summarizer` does. */
    adapter: AnyTextAdapter;
    model: string;
    modelOptions?: Record<string, unknown>;
    fit: FitOptions;
    signal: AbortSignal;
}

/**
 * `/compact`: folds the conversation's earlier turns into its notes now,
 * and says what it did. It never fails the chat: a failure is said as the
 * answer. Only a stop ends it. `compact.ts`'s `compactWith` is it.
 */
export interface CompactShape {
    compact(turn: CompactTurn): Promise<string>;
}

export class Compact extends Context.Service<Compact, CompactShape>()('socio/skills/Compact') {}

// ── Link unfurling (`unfurl-tool.ts`, `unfurl-recursive.ts`) ─────────────

/** What a turn's unfurl tools read and save with (`UnfurlWith`, minus the page tools). */
export interface UnfurlToolOptions {
    /** The workspace's web reader (web's `WebReader`): reads as the Dot's declared agent. */
    reads: { read(request: WebReadRequest): Promise<WebReadResult> };
    /** Where a card's media is copied (the user's Files). */
    media: MediaShape;
    turn: DotTurn;
    /** The FixTweet API (tests: a loopback fake). */
    fixTweetBase?: string;
    now?: () => number;
}

/**
 * `/unfurl`'s tools (CB-230, CB-328), as the web module offers them to a
 * turn: `unfurlTools` and `unfurlRecursiveTools` over the page tools the
 * tag was built with (`unfurlToolsOver` in `services.ts`).
 */
export interface UnfurlToolsShape {
    /** `unfurl_link`: one source into one page. */
    unfurlTools(options: UnfurlToolOptions): ToolDefinition[];
    /** `unfurl_recursive`: an index page and a child page per link. */
    unfurlRecursiveTools(options: UnfurlToolOptions): ToolDefinition[];
}

export class UnfurlTools extends Context.Service<UnfurlTools, UnfurlToolsShape>()('socio/skills/UnfurlTools') {}
