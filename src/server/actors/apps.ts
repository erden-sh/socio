import type { ActorsShape, AppActorAccess, AudiencePolicy, CheckResult } from './contract.js';

/** `AppActorAccess` (the contract's `AppActors` tag) over `ActorAccess`. */
export function appActorAccess(actors: ActorsShape): AppActorAccess {
    return {
        audiences: actors.audiences,
        appEnded: async (appId, by, reason) => (await actors.revoke({ audience: `app:${appId}` }, by, reason)).length,
        check: (token, request, bind) => actors.check(token, request, bind),
        contextKey: (contextId) => actors.contextKey(contextId),
        featureOn: (personId) => actors.featureOn(personId),
        mintObo: (input) => actors.credentials.mintObo(input),
        openObo: (token, appId) => actors.credentials.openObo(token, appId),
        authorize: (grantId, request) => actors.authorizer.authorize(grantId, request),
        grant: (id) => actors.grants.get(id),
        continuation: ({ grant, audience, requestId, ttlMs }) =>
            actors.credentials.issue({
                grant,
                kind: 'continuation',
                audiences: [audience],
                contextId: requestId,
                holder: { kind: 'grant', id: grant.id },
                ttlMs,
                correlationId: requestId,
            }),
        issuable: () => actors.issuable(),
        track: (grantId, handle) => actors.revocations.track(grantId, handle),
    };
}

export type { AudiencePolicy, CheckResult };
