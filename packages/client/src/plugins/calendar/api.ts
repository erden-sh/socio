import type { CalendarEventInput, CalendarEventView, CalendarState } from '@socio/shared/calendar';

import { api } from '../../lib/api';

/** The calendar plugin's routes, as the signed-in person. */
const BASE = '/plugins/calendar/data';

export const calendarApi = {
    state: (from: number, to: number, signal?: AbortSignal) =>
        api<CalendarState>(`${BASE}/state?from=${Math.floor(from)}&to=${Math.ceil(to)}`, 'GET', undefined, signal),
    create: (input: CalendarEventInput) =>
        api<{ event: CalendarEventView; outcome: 'created' | 'updated' }>(`${BASE}/events`, 'POST', input),
    update: (id: string, patch: Partial<CalendarEventInput>) =>
        api<{ event: CalendarEventView }>(`${BASE}/events/${encodeURIComponent(id)}`, 'PATCH', patch),
    remove: (id: string) => api<{ ok: true }>(`${BASE}/events/${encodeURIComponent(id)}`, 'DELETE'),
    createFeed: () => api<{ url: string }>(`${BASE}/feed`, 'POST', {}),
    removeFeed: () => api<{ ok: true }>(`${BASE}/feed`, 'DELETE'),
};
