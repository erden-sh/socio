// The purge's way to a socio's computer: the computer supervisor's own API
// (COMPUTER_SUPERVISOR_URL, COMPUTER_SUPERVISOR_TOKEN), never Docker. It lists
// the computers, and destroys a purged socio's container and its three volumes
// (POST /computers/:id/destroy, deployment/computers/computer-destroy.mjs).

export interface SupervisorComputer {
    botId: string;
    container: string;
    status: string;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PurgeSupervisor {
    list(): Promise<SupervisorComputer[]>;
    /** Whether this supervisor has the destroy route (an older image doesn't). */
    canDestroy(): Promise<boolean>;
    destroy(socioId: string): Promise<{ container: boolean; volumes: string[] }>;
}

/** The supervisor of this deployment, or none where computers are off. */
export function purgeSupervisor(
    env: Record<string, string | undefined>,
    fetchImpl: Fetch = (url, init) => fetch(url, init),
): PurgeSupervisor | undefined {
    const base = env.COMPUTER_SUPERVISOR_URL?.trim().replace(/\/$/, '');
    const token = env.COMPUTER_SUPERVISOR_TOKEN?.trim();
    if (!base) {
        return undefined;
    }
    // Computers run here: without the token, their cleanup can't happen, so stop rather than skip it.
    if (!token) {
        throw new Error(
            'COMPUTER_SUPERVISOR_URL is set but COMPUTER_SUPERVISOR_TOKEN is not: the purge can’t remove computers.',
        );
    }
    const call = (path: string, body?: unknown) =>
        fetchImpl(`${base}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: 'error',
            signal: AbortSignal.timeout(60_000),
        });
    return {
        async list() {
            const response = await call('/computers');
            if (!response.ok) {
                throw new Error(`The computer supervisor answered ${response.status} to the listing.`);
            }
            const { computers } = (await response.json()) as { computers?: SupervisorComputer[] };
            return computers ?? [];
        },
        async canDestroy() {
            // An id the route refuses (400) where it exists; an unknown route is 404.
            return (await call('/computers/-/destroy', {})).status === 400;
        },
        async destroy(socioId) {
            const response = await call(`/computers/${encodeURIComponent(socioId)}/destroy`, {});
            if (response.status === 404) {
                throw new Error(
                    'The computer supervisor can’t remove computers: update it to this release, then purge --resume.',
                );
            }
            if (!response.ok) {
                throw new Error(`The computer supervisor answered ${response.status} for ${socioId}'s computer.`);
            }
            const result = (await response.json()) as { container?: boolean; volumes?: string[] };
            return { container: !!result.container, volumes: result.volumes ?? [] };
        },
    };
}

/**
 * The computers step of a purge plan, decided before anything is deleted:
 * which purged socios have a listed computer, and why it can't run. Every
 * purged socio goes to the supervisor after the commit (a computer's volumes
 * can outlive its container, and the listing shows containers only), so the
 * route must exist whenever any socio goes; `keep` skips the step on purpose.
 */
export async function planComputers(
    supervisor: PurgeSupervisor | undefined,
    socios: readonly string[],
    keep = false,
): Promise<{ destroy: boolean; found: SupervisorComputer[]; refusal?: string }> {
    if (!supervisor || keep || !socios.length) {
        return { destroy: false, found: [] };
    }
    const found = (await supervisor.list()).filter((computer) => socios.includes(computer.botId));
    if (!(await supervisor.canDestroy())) {
        return {
            destroy: false,
            found,
            refusal: `The computer supervisor can't remove computers (${found.length} listed for the purged socios, and any volumes they left): update it to this release first, or pass --keep-computers to leave them.`,
        };
    }
    return { destroy: true, found };
}
