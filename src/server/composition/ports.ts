/**
 * The late-bound ports of the layer graph. A step in `composition/<x>.ts` reads
 * a port where it needs, inside a callback, a service built after its own or a
 * value set after the graph is built. Each is read at the moment of use, never
 * at build time, so the order of construction and every read stay as they were.
 *
 * The forward references, each filled by the step that builds the service:
 * - `orchestrator`: approvals → orchestrator (a work cycle waits while a
 *   room's next socio follows);
 * - `roomNotices`: rooms → roomNotices (the person invited hears of it);
 * - `steering`: orchestrator → steering;
 * - `computers`: apps → computers;
 * - `plugins`: workspaceSecrets → plugins;
 * - `github`: the gateways' audiences → github (the GitHub App in force);
 * - `turns` (`composition/app/turns.ts`) and `setup`
 *   (`composition/app/status.ts`), for the steps that run a turn or read
 *   the setup status.
 *
 * The values set after the graph is built: `telegram` and `backups` (their
 * boot steps, through `LeaderWork`), `listening` (`LeaderWork.awaitListening`),
 * `draining` (`LeaderWork.drain`) and `docs` (the docs catalog, boot phase 4).
 *
 * The root (`composition/root.ts`) offers one fresh set per graph as one
 * tag, `Ports`: each step reads the ports it needs from it.
 */
import { Context } from 'effect';

import type { AgentRunSource, SetupStatus } from '@socio/shared/types';

import type { BackupService } from '../backup/backup-service.js';
import type { ComputerService } from '../computers/computer-service.js';
import type { SteeringTurns } from '../context/steering-turns.js';
import type { DocsCatalogShape } from '../docs/contract.js';
import type { GitHubAppSettings } from '../github/settings.js';
import type { PluginService } from '../plugins/service.js';
import type { RoomNotices } from '../rooms/notices.js';
import type { RoomOrchestrator } from '../rooms/orchestrator.js';
import type { TelegramChannel } from '../telegram/telegram-channel.js';
import type { PlatformTurnOptions, TurnOutcome } from '../turns/contract.js';

/** A value its readers get at the moment of use: built after them, or set after construction. */
export class LatePort<T> {
    private value: T | undefined;
    private filled = false;
    constructor(readonly name: string) {}
    /** Fills the port (again, for a member set more than once) and returns the value. */
    fill<V extends T>(value: V): V {
        this.value = value;
        this.filled = true;
        return value;
    }
    /**
     * The value. A port read before it is filled throws, as reading the
     * service before it was built always did.
     */
    get(): T {
        if (!this.filled) {
            throw new Error(`The late-bound port "${this.name}" was read before it was filled.`);
        }
        return this.value as T;
    }
    /** The value, or undefined while unfilled: for the members that may stay unset. */
    peek(): T | undefined {
        return this.value;
    }
}

/**
 * A socio's turn and what goes with it (`turnOutcome`, `turn`, `history`,
 * `requireReady`), for the graph's steps that run turns after they are built.
 * Filled by the step that holds them (`composition/app/turns.ts`).
 */
export interface TurnsShape {
    turnOutcome(
        threadId: string,
        prompt: string,
        signal: AbortSignal,
        options?: PlatformTurnOptions,
    ): Promise<TurnOutcome>;
    turn(
        threadId: string,
        prompt: string,
        signal: AbortSignal,
        metadata?: Record<string, unknown>,
        source?: AgentRunSource,
    ): Promise<string>;
    history(threadId: string): Promise<string>;
    requireReady(): Promise<void>;
}

/**
 * The setup status (`AppStatus.setup`), for the steps built before it that
 * read it at the moment of use. Filled by `composition/app/status.ts`.
 */
export interface SetupShape {
    setup(userId?: string): Promise<SetupStatus>;
}

/** The graph's late-bound ports, one set per graph. */
export interface PlatformPorts {
    readonly orchestrator: LatePort<RoomOrchestrator>;
    readonly roomNotices: LatePort<RoomNotices>;
    readonly steering: LatePort<SteeringTurns>;
    readonly computers: LatePort<ComputerService>;
    readonly plugins: LatePort<PluginService>;
    /** The GitHub App's settings, filled right after github's step (`gatewayLayers.github`). */
    readonly github: LatePort<GitHubAppSettings>;
    readonly draining: LatePort<boolean>;
    readonly telegram: LatePort<TelegramChannel | undefined>;
    readonly backups: LatePort<BackupService | undefined>;
    readonly listening: LatePort<Promise<void> | undefined>;
    /** A socio's turn, filled by `composition/app/turns.ts`. */
    readonly turns: LatePort<TurnsShape>;
    /** The setup status, filled by `composition/app/status.ts`. */
    readonly setup: LatePort<SetupShape>;
    /** The docs catalog, filled at boot phase 4 (`loadDocs`). */
    readonly docs: LatePort<DocsCatalogShape>;
}

/** A fresh set of ports; `draining` starts false, as the field did. */
export function platformPorts(): PlatformPorts {
    const draining = new LatePort<boolean>('draining');
    draining.fill(false);
    return {
        orchestrator: new LatePort('orchestrator'),
        roomNotices: new LatePort('roomNotices'),
        steering: new LatePort('steering'),
        computers: new LatePort('computers'),
        plugins: new LatePort('plugins'),
        github: new LatePort('github'),
        draining,
        telegram: new LatePort('telegram'),
        backups: new LatePort('backups'),
        listening: new LatePort('listening'),
        turns: new LatePort('turns'),
        setup: new LatePort('setup'),
        docs: new LatePort('docs'),
    };
}

/** The graph's late-bound ports, as its steps read them. */
export class Ports extends Context.Service<Ports, PlatformPorts>()('socio/composition/Ports') {}
