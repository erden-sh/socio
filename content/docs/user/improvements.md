---
title: 'The Improvements board'
description: 'Report problems, request capabilities and follow decisions.'
---

The Improvements board is where the team tracks bugs, feature requests, documentation work and other changes. An item is a shared record with a stable issue key, description, status, comments and supporting files.

## Search before filing

Search for the behavior or capability you need, including closed items. A matching item may already be fixed, declined or blocked by another piece of work. Add a useful comment or vote for an existing request instead of splitting its history across duplicates.

When a turn fails, **File issue** under it in Runs fills in the report and links the item to that run, so the team can find the failure and see how long failures take to be reported. When filing a problem, describe what you tried, what happened, what you expected and how someone can reproduce it. Include the relevant screen, approximate time and version if known. An image can help, but crop credentials, private conversations and customer material before attaching it. A failed request is evidence of a problem, not proof of its cause.

## Tag the plugins and apps an item is about

**Components** say which plugins or apps an item is about: one or more plugins, one or more apps, **All plugins** or **All apps**. Choose them under **Components** when you report an item. Reporting from a plugin's page, from **Report issue** on a plugin's settings, or from an app's **Report issue** on the Apps page or a socio's home page starts with that plugin or app chosen; remove it if it doesn't fit. After filing, only admins change an item's components, as with its area.

You can choose, and see, only the plugins you may use and the apps you may open: your own, and those shared with a Space you belong to. Admins see every plugin and every app's name and owner. A tag you can't see is left out entirely, wherever the item appears; the item itself stays visible. When an admin changes the components, the tags you can't see stay as they were.

Filter the board by one component with the **Component** filter. It matches exactly: **All plugins** finds the items tagged **All plugins**, not those tagged with one plugin. A plugin that was uninstalled, or an app that was deleted, keeps the name it had and is shown as such; a new app at a deleted app's address is a different app.

When automatic triage is on, its proposal can suggest components too. Admins see every suggestion while they review; anyone else sees only the suggestions for plugins and apps they can see. The proposal's comment says only how many were suggested.

## Understand progress

Admins triage items, set priorities, assign work and change status. Members can file, comment and vote but cannot change those administrative fields. A connected agent has the same limits as the person who authorized it.

Open an item to read its comments and linked items. **Blocked by** means another item must be addressed first; **Blocks** identifies dependent work; **Related** items are connected without either waiting for the other, such as a similar report or the same area of work. Status history records changes the system actually knows about. A status or a proposed fix does not prove that the behavior was verified on your deployment; read the resolution and validation details.

## Refer to other items

Type `#123` or `CB-123` in a description or comment to refer to item CB-123. Once saved, the reference shows as a chip with the item's key and title; select it, or move to it with Tab and press Enter, to open that item. A reference to an item you can't see, or one that doesn't exist, stays as the text you typed. References inside code (`#123` between backticks, or a code block), inside links, and `#` numbers in headings stay as written, as do web addresses and colors such as `#fff`.

## Link items

Link items in the item's side panel, under **Link an issue**: choose the type of link, enter the item's key (such as `CB-12`) and select **Add**. **Related to** is the default. Two items have one link between them.

- **Everyone** can link items as **Related to**, and remove a related link with the **×** button on its row.
- **Admins** can also make one item block another (**Blocks** or **Blocked by**), change any link's type with the menu on its row, and remove any link. Blocking links affect triage, so members can read them but not add, change or remove them, nor replace one with a related link.

Changing a link to one that would make items wait for each other in a loop is refused, and the old link stays. A connected agent or socio filing an item for you can add related links to it; blocking links only when you are an admin.

## Requests from socios

A socio can propose a missing capability, or file an issue when permitted. Similar capability requests may be combined with a demand count, so explain the concrete use case rather than filing the same idea repeatedly. The people who requested a capability can receive a notice when it is resolved.

Automated triage, when enabled by the team, supports the workflow but does not replace review. A branch or pull request from a coding session is not a released fix. To change an item's priority or status, ask an admin and explain the impact. Read [Connected agents](/docs/connected-agents) if you want an external agent to help maintain issue records.
