import type { NotificationContent } from '@socio/shared/notifications';

import type { NotificationContentInput, RenderedNotification } from './contract.js';

/**
 * The message as sent: "<title or Dot>", the message, its image; or in
 * private mode only "<Dot> needs you", which leaves the brain with no
 * message text and no image, encrypted or not.
 */
export function render(
    input: NotificationContentInput,
    content: NotificationContent,
    origin: string,
): RenderedNotification {
    const absolute = (path: string) => `${origin.replace(/\/$/, '')}${path}`;
    const common = {
        path: input.path,
        url: absolute(input.path),
        ...(input.icon ? { icon: absolute(input.icon) } : {}),
        ...(input.tag ? { tag: input.tag } : {}),
    };
    if (content === 'private') {
        return {
            ...common,
            title: `${input.from} needs you`,
            body: 'Open Socio to see why.',
        };
    }
    return {
        ...common,
        title: input.title ? `${input.from}: ${input.title}` : input.from,
        body: input.message,
        ...(input.image ? { image: input.image } : {}),
    };
}
