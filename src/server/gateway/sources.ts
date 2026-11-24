/**
 * What `gateway/` reads of the rest of the app, as slices of other
 * features' contracts.
 * It replaces `platform-needs.ts` inside the folder: no class of another
 * folder is named here. The layer (`layer.ts`) builds it from the tags, and
 * the gateways' step offers it with the coding sessions as `HostedGateway`
 * (`adopted.ts`).
 */
import type { DatabaseSync } from 'node:sqlite';

import type { ActorsShape } from '../actors/contract.js';
import type { ApprovalsShape } from '../approvals/contract.js';
import type { AppsShape } from '../apps/contract.js';
import type { CodeAccessShape } from '../auth/contract.js';
import type { GatewayExchangesShape } from '../coding/contract.js';
import type { DataSpaceShape } from '../dataspace/contract.js';
import type { FlagsShape } from '../flags/contract.js';
import type { GitHubClientsShape, GitHubSettingsShape } from '../github/contract.js';
import type { InferenceShape } from '../inference/contract.js';
import type { RuntimeIdentityShape } from '../runtime/contract.js';
import type { LinksShape } from '../telegram/contract.js';
import type { ReleasesShape } from '../updates/contract.js';
import type { ConversationsShape, PeopleShape, SociosShape } from '../workspace/contract.js';

import type { GatewayConfigShape } from './contract.js';

/**
 * The workspace as the gateways read it: the people (who may be listed,
 * their names), the socios (commit identities, who may use one), the
 * conversations (an extraction's chat), the Telegram links (whether a
 * chat is a group) and the connection the gateways' own tables are on.
 */
export type GatewayWorkspace = Pick<PeopleShape, 'users' | 'hasUser'> &
    Pick<SociosShape, 'dot' | 'canUseDot'> &
    Pick<ConversationsShape, 'thread'> & {
        readonly db: DatabaseSync;
        readonly telegram: Pick<LinksShape, 'threadInfo'>;
    };

/** Everything the model and Git gateways, their routes, tools and listener use of other features. */
export interface GatewaySources {
    /** Socio-actor access: audiences, grants, checks, the audit, revocations, credentials. */
    readonly actors: ActorsShape;
    /** The extraction cards (`repo_extract`). */
    readonly approvals: Pick<ApprovalsShape, 'register' | 'request'>;
    /** The workspace apps an extraction goes to. */
    readonly apps: Pick<AppsShape, 'all' | 'get' | 'url' | 'access'>;
    /** The person's files, where an extraction's copy is kept. */
    readonly data: Pick<DataSpaceShape, 'getFile' | 'putFile' | 'deleteFile'>;
    readonly flags: FlagsShape;
    /**
     * The GitHub App in force, read when a token is minted. The layer gets
     * it at the moment of use: github's step comes after the gateways'.
     */
    readonly github: Pick<GitHubSettingsShape, 'inForce'>;
    /** How the gateways reach GitHub (`GitHubClients`). */
    readonly githubClients: GitHubClientsShape;
    /** Coding endpoints, the operator's backends and people's own plans. */
    readonly inference: InferenceShape;
    /** This process's ownership of in-flight work, for the token ledger. */
    readonly runtime: Pick<RuntimeIdentityShape, 'attach'>;
    /** Who may run code (CB-376): the `code:run` permission, read on every use. */
    readonly codeAccess: CodeAccessShape;
    /** The coding sessions' exchange log (CB-326). */
    readonly exchanges: GatewayExchangesShape;
    /** The build's release, for the gateway's `User-Agent`. */
    readonly releases: ReleasesShape;
    readonly workspace: GatewayWorkspace;
    readonly config: GatewayConfigShape;
}
