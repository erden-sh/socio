---
title: 'Admin help'
description: 'Manage the workspace without confusing administration with personal ownership.'
---

Admins organize the workspace, configure shared behavior and review the work that affects the team. One admin is the workspace owner, whom other admins can't remove. Member access is narrower. A connected agent acts within its person's role rather than gaining an independent administrator identity.

## Manage the team’s capabilities

Use [Socios administration](/docs/admin/socios) to review role instructions, Space access, computer capabilities and personal versus workspace creation. Use [Settings and people](/docs/admin/settings) for global controls, invitations, account lifecycle and model availability.

[Plugins](/docs/admin/plugins) adds features such as the shared calendar to this instance and decides who can use them. Choose [Service accounts](/docs/admin/service-accounts) for company-owned REST automation. Choose [Connected agents](/docs/admin/connected-agents) when a person authorizes an external agent to act for them. External MCP connections in a person's profile are the opposite direction: Socio calls another service using that person's connection. [Socio access for apps](/docs/admin/socio-access-for-apps) explains how a mini app lets socios use it for a person, and what each of its actions needs.

## Private Spaces

A Space is for the whole workspace or, when private, for only its people. Admins are editors of every Space, private ones included: they see them all, with a lock on the private ones, in the sidebar, search and Operations. Admins make Spaces for the whole workspace, and only admins open a private Space to everyone; anyone can make a private Space for themselves and the colleagues they choose. Private covers everything in the Space: its pages and their history, page chats, search, apps, datasets and files shared with it, and its memory. People outside it, and socios in chats with them, don't see that it exists. Who sees each Space is under its **Settings** tab; existing Spaces stay open to the whole workspace until someone makes them private. See [Spaces](/docs/spaces).

Give a company socio a private Space only when that is intended: it uses the Space only in chats where everyone can see it, but it will name it to them there. A socio made by a member can be given only Spaces that member can see.

## Delete and restore Spaces

A private Space's editors can delete it, and admins can delete any Space, from its **Settings** tab: **Delete this Space**, then type its name. It is gone for everyone at once, with everything in it: its pages, page and Ask chats about them, its shared memory, the apps, datasets and link cards shared with it (their owners keep their own), and socios' access to it. Socios and connected agents no longer see it, and links to it say it was not found. Socios can't delete a Space.

Nothing is erased. **Settings → Deleted Spaces** lists each deleted Space with who deleted it and when; **Restore** brings it back with everything in it, for the people who could see it before, private or not as it was. Deleted Spaces are kept until an admin restores them. Deleting and restoring are recorded in the workspace audit.

A Space can't be deleted while a socio saves new pages to it by default: change that socio's default Space first. The workspace always keeps one Space. While Socio is being updated, deleting waits a few minutes until the previous release has stopped.

## Review and govern

**Operations** shows how the workspace is used. Its Knowledge page maps which Spaces' pages socios read to answer and which pages grounded the most chats; socios record what they read as references (ids, kind and Space), never the content. A chat's transcript there shows what its turns read, and opening either a transcript or its grounding is written to the access log every admin can see. Reliability shows how long failed turns take to be reported with **File issue**.

[Learning and skills](/docs/admin/learning) explains conversation evidence, proposals and published procedures. Admins see Learning; members see published Skills. Chat skills that a person invokes with a slash command are a separate kind of instruction.

[Failure labels](/docs/admin/failure-labels) explains how to sort the failures that Operations → Reliability leaves Unclassified, and when the model's suggested labels start to count.

[Intent and themes](/docs/admin/themes) explains what Operations → Themes shows, how it protects people's privacy, and how to review sessions before the model's labels count.

Explain sharing before granting broader access. A personal socio's settings remain manageable by an admin, but that does not transfer ownership of its user's private chats or personal files. Shared pages and workspace computer resources have different boundaries; use the [user privacy guide](/docs/privacy) when explaining them.

Make one purposeful change at a time, inspect the saved value and verify the affected flow using authorized accounts. Keep credentials, one-time links and private conversation material out of Improvements items and screenshots. A saved setting or a completed automated proposal is not a substitute for checking the resulting behavior.
