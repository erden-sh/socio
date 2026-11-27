import { createElement } from 'react';

import { findChat, type RouteHandle } from '../../shell/shell-context';

import { ChatTitleCrumb } from './chat-menu';
import { DotCrumb } from './dot-crumb';
import { dotPath } from './nav';

/**
 * A Dot's home page (CB-89): the computer pane docks beside it, as on its
 * chats; the crumb is the Dot's name.
 */
export const dotHomeHandle: RouteHandle = {
    chat: true,
    crumb: ({ dot }) => [{ label: dot.name }],
};

/**
 * A new chat: the pane docks beside it; the crumbs are the Dot (its
 * chats menu) and "New chat" (chat.menu, which its route inlines).
 */
export const chatHandle: RouteHandle = {
    chat: true,
    crumb: ({ dot, t }) => [
        {
            label: dot.name,
            to: dotPath(dot),
            node: createElement(DotCrumb, { dot }),
        },
        // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
        { label: t('chat.menu:new-chat') },
    ],
};

/**
 * A conversation: the Dot (a menu of its chats, its home page and a new
 * chat, CB-89), then the chat's title with its menu (CB-66), rendered on
 * the server too.
 */
export const chatThreadHandle: RouteHandle = {
    chat: true,
    crumb: ({ dot, workspace, params }) => {
        const thread = findChat(workspace, params.threadId);
        return thread
            ? [
                  {
                      label: dot.name,
                      to: dotPath(dot),
                      node: createElement(DotCrumb, { dot, threadId: thread.id }),
                  },
                  {
                      label: thread.title,
                      node: createElement(ChatTitleCrumb, { thread }),
                  },
              ]
            : [{ label: dot.name }];
    },
};

/**
 * A socio's Soul (CB-179): the socio (its home page, when the person has
 * it in their list), then "Soul" (chat.soul, which its route inlines).
 */
export const soulHandle: RouteHandle = {
    crumb: ({ workspace, params, t }) => {
        const dot = workspace.dots.find((item) => item.id === params.dotId);
        // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
        const soul = { label: t('chat.soul:crumb') };
        return dot ? [{ label: dot.name, to: dotPath(dot) }, soul] : [soul];
    },
};
