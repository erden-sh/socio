import type { GuideId } from '@socio/shared/onboarding';

export const OPEN_GUIDES = 'socio:open-guides';
/** Same-tab shell action, like the board's report dialog; no app data is sent. */
export function openGuides(id?: GuideId) {
    window.dispatchEvent(new CustomEvent(OPEN_GUIDES, { detail: id }));
}
