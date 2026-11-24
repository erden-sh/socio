import type { PlannerState } from './types';

export async function plannerCall<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const data = text ? (JSON.parse(text) as { error?: string }) : {};
    if (!response.ok) {
        throw new Error(data.error || text.slice(0, 200) || response.statusText);
    }
    return data as T;
}

export function loadState() {
    return plannerCall<PlannerState>('GET', '/api/state');
}

export function readInitialState(): PlannerState | undefined {
    const node = document.getElementById('planner-state');
    if (!node?.textContent) {
        return undefined;
    }
    try {
        return JSON.parse(node.textContent) as PlannerState;
    } catch {
        return undefined;
    }
}
