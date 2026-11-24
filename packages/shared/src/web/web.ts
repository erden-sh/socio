import type { ApprovalsState, ApprovalView } from '../approvals.js';
import type { SignInMethods } from '../auth.js';
import type { DatasetDetail, DataSpaceState } from '../data-types.js';
import type { OperatorInferenceState } from '../inference.js';
import type { IssueDetail } from '../issues/issue-types.js';
import type { LearningContainerDetail, LearningContainerSummary, PublishedSkills } from '../learning.js';
import type { MediaKind, MediaListing } from '../media-types.js';
import type { MemoriesState } from '../memory.js';
import type { PageLibrary } from '../pages/page-library.js';
import type { ScheduleDetail, SchedulesState } from '../schedule-types.js';
import type { AgentRunSummary, State, User, WorkspaceState } from '../types.js';

/** What the sign-in screen offers: `/api/auth/session` without the user. */
export interface SignInView {
    provider: string;
    branding?: import('../branding.js').Branding;
    /** Better Auth's methods; none for the mock user picker. */
    methods?: SignInMethods;
}

/**
 * What page loaders and middleware read, in the server's own process
 * (src/server/web/services.ts). Each method returns what its API route
 * returns to the same user, through the same views (each feature's views
 * tag, src/server/web/services.ts's `PageViews`). One set per page request: the answers are kept
 * for the request, so the shell and a module gate share them.
 */
export interface WebServices {
    /** Current viewer's docs, resolved before looking up even unknown URLs. */
    docsPage?(url: string): Promise<import('../docs.js').DocsScreen | null>;
    /** The same viewer's navigation, for the not-found page (CB-264). */
    docsTree?(): Promise<import('../docs.js').DocsTree | null>;
    docsMarkdown?(url: string): Promise<string | null>;
    docsSearch?(query: string): Promise<unknown[]>;
    docsLlms?(full: boolean): Promise<string>;
    /** The signed-in user; null when signed out. */
    user(): Promise<User | null>;
    /** What the sign-in screen offers. */
    signIn(): Promise<SignInView>;
    /** `GET /api/state`. Signed in only: it throws without a user. */
    state(): Promise<State>;
    /**
     * `GET /api/workspace`; undefined on a server without a platform.
     * Signed in only: it throws without a user.
     */
    workspace(): Promise<WorkspaceState | undefined>;
    // Page loaders (RR-SSR step 6). Signed in only, like state(); each is
    // its API route's answer, or null where the route answers 404.
    /** `GET /api/issues/:number`. */
    issue(number: number): Promise<IssueDetail | null>;
    /**
     * `GET /api/spaces/:id/pages?bodies=false&include=<page>`: the library's
     * first screen, with the open page.
     */
    spaceLibrary(spaceId: string, pageId?: string): Promise<PageLibrary | null>;
    /** `GET /api/approvals`: this user's own. */
    approvals(): Promise<ApprovalsState | null>;
    /** `GET /api/approvals/:id`: one of this user's own requests. */
    approval(id: string): Promise<ApprovalView | null>;
    /** `GET /api/runs?limit=<limit>`, for admins only (null for members). */
    runs(limit: number): Promise<RunList | null>;
    /**
     * `GET /api/media?folder=&q=&kind=`: a folder of the user's own files;
     * null for a folder or search the API refuses.
     */
    media(query: MediaQuery): Promise<MediaListing | null>;
    /** `GET /api/data?files=false`: the user's datasets, grants and usage. */
    data(): Promise<DataSpaceState | null>;
    /** `GET /api/data/datasets/:id`: a dataset this user may see. */
    dataset(id: string): Promise<DatasetDetail | null>;
    /** `GET /api/schedules`: the user's own schedules and jobs. */
    schedules(): Promise<SchedulesState | null>;
    /** `GET /api/schedules/:id`: one of the user's own schedules, in full. */
    schedule(id: string): Promise<ScheduleDetail | null>;
    /** `GET /api/learning/skills`: everyone's published skills. */
    learningSkills(): Promise<PublishedSkills | null>;
    /** `GET /api/learning/containers`, for admins only (null for members). */
    learningContainers(): Promise<LearningContainerSummary[] | null>;
    /**
     * `GET /api/learning/containers/:id?bodies=false`, for admins only:
     * the first page of proposals, without their SKILL.md and rationale.
     */
    learningContainer(id: string): Promise<LearningContainerDetail | null>;
    /** `GET /api/inference`, for operators only (null for everyone else). */
    inference(): Promise<OperatorInferenceState | null>;
    /** `GET /api/memories`: the user's own profile, memories and proposals. */
    memories(): Promise<MemoriesState>;
}

/** What the Media page lists: a folder, a search under it, a kind. */
export interface MediaQuery {
    folder?: string;
    q?: string;
    kind?: MediaKind;
}

/** `GET /api/runs`: the latest runs, at most `limit`. */
export interface RunList {
    limit: number;
    runs: AgentRunSummary[];
}

/**
 * What the Hono server hands the page renderer for one page request,
 * through the router context (packages/client/src/lib/web-context.ts).
 */
export interface WebContext {
    services: WebServices;
    /** This response's CSP nonce: every inline script carries it. */
    nonce: string;
}
