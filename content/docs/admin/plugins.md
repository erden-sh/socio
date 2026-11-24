---
title: 'Plugins'
description: 'Install features on this instance, choose who can use them, and set up the calendar.'
---

**Plugins** in the sidebar is for admins. It lists what this instance offers and what is installed. Nothing is installed until an admin installs it, and uninstalling keeps the plugin's data for a later install.

Whoever operates the server decides what this instance offers, the calendar included: a plugin that ships with Socio is offered only when they list it. If **Plugins** offers nothing, or not the calendar, ask them. When they stop offering a plugin that is already installed, it stays installed and keeps working, and its card under **Installed** says "no longer in the catalog". You can still disable or uninstall it there; uninstalling keeps its data, but it can't be installed again until it is offered again.

## Two kinds of plugin

- **Runs inside Socio.** Code that ships with Socio, such as the calendar. Installing it is the whole setup: there is nothing to deploy, and it has no replicas to scale.
- **Runs as its own service.** A separate service on the workspace app runtime, opened on its own address. It needs the app runtime set up by whoever operates the server, and its card shows whether it is running and how many replicas it has.

## Choose who can use it

Each installed plugin has **Who can use it**: **Admins only** or **Everyone (members too)**. It decides who sees the plugin in the sidebar, who can open it, whose connected agents and socios get its tools, and whose calendar subscription links keep working. Narrowing it to admins takes the plugin away from members at their next request, including tools a socio already had in a running chat. Installing, settings, the audience itself and uninstalling stay with admins.

## Settings

A plugin's settings are on its installed card. Saving applies them at once. For a plugin that runs as a service, saving restarts it with the new values.

## Calendar

Install **Calendar** from Plugins. It starts open to everyone; switch **Who can use it** to admins if only admins should see it. Its settings:

- **timeZone**: the calendar's time zone, such as `America/New_York`. Empty uses the workspace's, from Operations. New events are in this zone unless whoever adds one names another, and the calendar page shows times in it.
- **writers**: `everyone` lets everyone who can open the calendar add events; `admins` lets only admins add them.
- **editing**: `own` lets people change and delete the events they created (admins can change any shared event); `everyone` lets anyone who may add events change them.

A private event is visible only to the person who created it, admins included.

### Copying events from another system

An agent that copies bookings in (from Notion, for example) uses the calendar's tools through the workspace's connected-agent endpoint. The person who connects it must approve the calendar's own permissions on the consent screen (**Read data in the Calendar plugin** and **Add and change data in the Calendar plugin**); a connection approved before the calendar was installed does not have them, so reconnect it. The agent acts as that person, with their permissions, and each event records the agent's name.

The agent should pass a source and the original's id (for example `notion` and the Notion page id) with each event. Sending the same page again updates the event already there instead of making a second one, so a sync can run every day.

### Subscription links

Each person can make a private link from the calendar page that Google Calendar, Apple Calendar or Outlook can subscribe to. Anyone with a link can read the events it shows, so treat it like a password. Making a new link ends the old one. A link stops working when its person is deactivated, when they can no longer use the plugin, or while the plugin is disabled.
