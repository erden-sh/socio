---
title: 'Connected-agent administration'
description: 'Review inbound agent grants and distinguish outbound tool connections.'
---

## Inbound: an agent acting for a person

A connected agent uses the workspace's `/mcp` endpoint with a grant a person approved in their browser. The grant records both the client and the person. Its effective authority is its granted scopes and that person's role. A member's agent cannot change issue status just because the tool exists.

Connected agents require Better Auth. Clients must support the authorization flow used by the server, including Client ID Metadata Documents, authorization code flow and S256 PKCE. A generic “MCP support” label on a client is not sufficient evidence that its authorization flow is compatible.

On **Admin → Connected agents**, inspect grants, the person who authorized them, labels, client domains, scopes and last use. Labels should identify the client and where it runs. Approving the same client twice produces distinct grants; it does not prove one installation is a duplicate of another.

## Help access is explicit

The optional inbound help tools `list_docs`, `read_docs` and `search_docs` require a new `docs:read` grant. Existing `issues:read`, `issues:write` or `pages:read` consent does not authorize them. Clients must request the scope and people must approve it explicitly; a reconnect may be needed. Tools resolve the person's current role for the documentation view, so a granted scope does not turn a member into an admin or operator.

Public `/llms.txt`, `/llms-full.txt` and Markdown article exports provide another way to read help without an MCP grant. Their responses are audience-filtered too. They expose documentation, not the contents of workspace pages.

## Plugin tools

Tools that an installed plugin adds (the calendar's `list_events` and `create_event`, the social planner's `list_planned_posts` and the rest) appear only for a connection whose person may use that plugin (its **Who can use it** on [Plugins](/docs/admin/plugins)), and only within its scopes. Each plugin has its own: `plugins:calendar:read` for the calendar's list tool and `plugins:calendar:write` for the tools that add or change events. The older `plugins:read` and `plugins:write` cover only the social planner, the one plugin there was when they were introduced; they never cover a plugin added since, so a connection that holds only them gets no calendar tools and must be authorized again with the calendar's own scopes. A connection without any of them sees none of those tools, a read-only one sees only the list tools, and a call outside the granted scopes is refused before it runs. Existing grants do not gain these scopes; the client must request them and the person must approve the new consent. Socios in the app get the same tools for the people who may use the plugin, with no consent step.

## Restrict or disconnect

Each person can disconnect their own grants under Account. Admins can disconnect grants across the workspace, and those decisions are audited. Disconnection removes the grant's access and refresh tokens; deactivating a person disconnects all their agents. Reactivation does not reconnect them.

The optional allowed-client-domain list restricts metadata domains, including their subdomains. Existing grants outside a changed allowlist stop working. A local client's claimed domain remains unverified; it is not a strong assurance of the program on someone's machine. Review consent requests only when the person actually initiated the connection.

## Outbound: Socio using an external provider

A person's **External MCP connections**, under their Profile, let Socio request external tools. These are per-person connections, not inbound agent grants or service-account keys. Other users do not inherit them from a workspace socio. Refreshing a catalog clears existing tool grants for review, and every external call needs manual approval.

Disconnecting here clears Socio's credentials and access; a provider-side authorization may also need revocation there. Do not claim a provider is compatible merely because a draft connection was saved or discovery succeeded.

Use [Service accounts](/docs/admin/service-accounts) for company-owned REST integrations. Direct people to the [user connection guide](/docs/connected-agents) for their consent and grant-management workflow.
