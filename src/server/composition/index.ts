/**
 * The composition root's graph. Each feature's `composition/<x>.ts` exports
 * one named value, `<x>Layers`: its steps of the graph, each a `Layer`
 * that yields the tags it needs and provides its own. This file only
 * imports them and wires them, in the order the services have always been
 * built, so a feature's PR changes its own file, never this one.
 *
 * The graph is a chain over the root's tags (`composition/root.ts`): each
 * step is provided everything built before it (`Layer.provideMerge`), so
 * each is built once, in this order, after the one before. A step reads a
 * service built after it through a late-bound port (`ports.ts`), at the
 * moment of use. The steps are interleaved across features because their
 * constructions register listeners (on the runner, the workspace, the
 * approvals) whose order is behavior: a step that builds a service never
 * moves.
 *
 * The steps in `composition/app/` hold the app's own code, which composes
 * many features (status, data keys, notices, conversations, room work,
 * turns, the leader's work and the drain, dictation), each placed after
 * every service it reads.
 *
 * The leaf bridges come first: settings, storage, web, the
 * runtime's tags, Telegram's links and the computers' records each offer
 * an object the root already holds, build nothing and take no listener,
 * so the steps after them yield their tags instead of providing copies.
 * The other bridges come after the services they read; the steps after
 * those (`Ask`, `ActorActions`, `Docs`, `Voice`) close the graph.
 */
import { Layer } from 'effect';

import { actorsLayers } from './actors.js';
import { agentsLayers } from './agents.js';
import { appConversationsLayers } from './app/conversations.js';
import { appDataKeysLayers } from './app/data-keys.js';
import { appDictationLayers } from './app/dictation.js';
import { appNoticesLayers } from './app/notices.js';
import { appRoomWorkLayers } from './app/room-work.js';
import { appStatusLayers } from './app/status.js';
import { appTurnsLayers } from './app/turns.js';
import { appWorkLayers } from './app/work.js';
import { approvalsLayers } from './approvals.js';
import { appsLayers } from './apps.js';
import { askLayers } from './ask.js';
import { capabilitiesLayers } from './capabilities.js';
import { chatNameSuggestionsLayers } from './chat-name-suggestions.js';
import { classifyLayers } from './classify.js';
import { codingLayers } from './coding.js';
import { computersLayers } from './computers.js';
import { contextLayers } from './context.js';
import { cyclesLayers } from './cycles.js';
import { dataspaceLayers } from './dataspace.js';
import { docsLayers } from './docs.js';
import { domainsLayers } from './domains.js';
import { dotsLayers } from './dots.js';
import { flagsLayers } from './flags.js';
import { gatewayLayers } from './gateway.js';
import { githubLayers } from './github.js';
import { inferenceLayers } from './inference.js';
import { integrationsLayers } from './integrations.js';
import { issuesLayers } from './issues.js';
import { keysLayers } from './keys.js';
import { learningLayers } from './learning.js';
import { liveLayers } from './live.js';
import { mcpLayers } from './mcp.js';
import { mediaLayers } from './media.js';
import { memoryLayers } from './memory.js';
import { notificationsLayers } from './notifications.js';
import { operationsLayers } from './operations.js';
import { pagesLayers } from './pages.js';
import { pluginsLayers } from './plugins.js';
import { replayLayers } from './replay.js';
import { roomsLayers } from './rooms.js';
import { runsLayers } from './runs.js';
import { runtimeLayers } from './runtime.js';
import { schedulesLayers } from './schedules.js';
import { searchLayers } from './search.js';
import { serviceAccountsLayers } from './service-accounts.js';
import { settingsLayers } from './settings.js';
import { skillsLayers } from './skills.js';
import { soulsLayers } from './souls.js';
import { spacesLayers } from './spaces.js';
import { storageLayers } from './storage.js';
import { telegramLayers } from './telegram.js';
import { turnsLayers } from './turns.js';
import { updatesLayers } from './updates.js';
import { voiceLayers } from './voice.js';
import { webLayers } from './web.js';
import { workspaceSecretsLayers } from './workspace-secrets.js';
import { workspaceLayers } from './workspace.js';

/** The next step, built after everything before it, which it may yield. */
const then =
    <A, R>(step: Layer.Layer<A, never, R>) =>
    <B, RB>(built: Layer.Layer<B, never, RB>) =>
        step.pipe(Layer.provideMerge(built));

/**
 * Every service of the app, as a layer over `root`: the tags
 * `composition/root.ts` provides first (`base.ts`, `ports.ts`).
 */
export function appGraph<B, RB>(root: Layer.Layer<B, never, RB>) {
    return root
        .pipe(
            // The leaf bridges: over the root's objects only.
            then(settingsLayers.bridges),
            then(storageLayers.bridges),
            then(webLayers.bridges),
            then(runtimeLayers.bridges),
            then(telegramLayers.links),
            then(computersLayers.bridges),
            then(appDictationLayers.step),
        )
        .pipe(
            then(cyclesLayers.cycles),
            then(flagsLayers.flags),
            then(keysLayers.keys),
            then(mcpLayers.connections),
            then(mcpLayers.oauth),
            then(spacesLayers.contracts),
            then(actorsLayers.actors),
            then(inferenceLayers.inference),
            then(approvalsLayers.approvals),
            then(spacesLayers.creation),
            then(mcpLayers.runtime),
            then(serviceAccountsLayers.serviceAccounts),
            then(roomsLayers.switch),
            then(roomsLayers.streams),
            then(appRoomWorkLayers.step),
            then(roomsLayers.membership),
            then(roomsLayers.topics),
            then(roomsLayers.orchestrator),
            then(agentsLayers.grants),
        )
        .pipe(
            then(dataspaceLayers.data),
            then(mediaLayers.media),
            then(operationsLayers.resourcePolicy),
            then(pagesLayers.retention),
            then(notificationsLayers.notifications),
            then(appNoticesLayers.step),
            then(appsLayers.apps),
            then(workspaceSecretsLayers.workspaceSecrets),
            then(gatewayLayers.audiences),
            then(pluginsLayers.plugins),
            then(operationsLayers.analytics),
            then(domainsLayers.domains),
            then(updatesLayers.updates),
            then(capabilitiesLayers.capabilities),
            then(dotsLayers.extensions),
            then(approvalsLayers.notices),
            then(approvalsLayers.continuations),
            then(contextLayers.steering),
            then(roomsLayers.notices),
        )
        .pipe(
            then(inferenceLayers.seed),
            then(inferenceLayers.shared),
            then(chatNameSuggestionsLayers.titles),
            then(chatNameSuggestionsLayers.repo),
            then(chatNameSuggestionsLayers.chatNames),
            then(learningLayers.learning),
            then(issuesLayers.autoTriage),
            then(learningLayers.evidence),
            then(operationsLayers.nudge),
            then(turnsLayers.log),
            then(turnsLayers.traceExporter),
            then(voiceLayers.transcriptionKeys),
            then(githubLayers.github),
            then(gatewayLayers.github),
            then(computersLayers.computers),
            then(schedulesLayers.data),
            then(schedulesLayers.jobs),
            then(schedulesLayers.longRuns),
            then(schedulesLayers.longRunReports),
        )
        .pipe(
            then(schedulesLayers.schedules),
            then(schedulesLayers.goals),
            then(pagesLayers.service),
            then(dotsLayers.handler),
            then(liveLayers.counters),
            // The app's own code (composition/app/): after every service it
            // reads, before the contracts' bridges.
            then(appTurnsLayers.step),
            then(appConversationsLayers.step),
            then(appDataKeysLayers.step),
            then(appStatusLayers.step),
            then(appWorkLayers.step),
            // The runtime's `Lifecycle`: the drain, through `LeaderWork`.
            then(runtimeLayers.lifecycle),
        )
        .pipe(
            // The contracts' tags over what is built above: no service is built
            // here, and none takes a listener, so they come after every service
            // and change no order. Each comes after the bridges it reads
            // (skills after context and pages).
            then(memoryLayers.bridges),
            then(integrationsLayers.bridges),
            then(searchLayers.bridges),
            then(soulsLayers.bridges),
            then(classifyLayers.bridges),
            then(runsLayers.bridges),
            then(workspaceLayers.bridges),
            then(schedulesLayers.bridges),
            then(contextLayers.bridges),
            then(pagesLayers.bridges),
            then(dataspaceLayers.bridges),
            then(skillsLayers.bridges),
            then(gatewayLayers.bridges),
            then(replayLayers.bridges),
            then(codingLayers.bridges),
            then(telegramLayers.bridges),
        )
        .pipe(
            // What closes the graph: the panel's `Ask` (handed to its
            // module), `ActorActions` over the approvals, apps and plugins
            // built above, `Docs` (its catalog filled at boot phase 4), then
            // `Voice`, whose approvals listener comes after every other, as
            // when the HTTP edge built it after the graph.
            then(askLayers.bridges),
            then(actorsLayers.actions),
            then(docsLayers.bridges),
            then(voiceLayers.voice),
        );
}
