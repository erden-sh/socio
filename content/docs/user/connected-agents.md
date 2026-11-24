---
title: 'Connected agents and external tools'
description: 'Distinguish an agent connecting into Socio from tools your socio calls elsewhere.'
---

There are two directions of connection. A **connected agent** is your external assistant using Socio's tools on your behalf. An **external MCP connection** lets a socio in Socio request tools from another provider. Approving one does not enable the other.

## Let your agent work in Socio

Give a compatible MCP client your workspace origin followed by `/mcp`. The client must support the authorization flow used by Socio, including Client ID Metadata Documents. Start authentication in that client, then review the browser consent screen: the client identity and domain, requested scopes, and the account you are authorizing.

Approve only a connection you just initiated. An **Unverified local app** label means a program on your computer can claim that identity; the label is not a guarantee about who is running it. Choose a connection name that tells you where it is used.

Under **Account → Connected agents**, inspect your grants and disconnect those you no longer use. A grant's scopes limit its tools, and your role still applies: your member agent cannot change administrative issue fields. Disconnecting ends that grant; deactivation ends a person's grants, and reactivation does not restore them automatically.

## Let a connected agent read help

The inbound MCP tools `list_docs`, `read_docs` and `search_docs` require the separate `docs:read` scope. Ask the client to request that scope and approve the new consent; reconnect or authorize again as needed. Existing issue/page grants are not silently extended. Help tools apply your current role, so a member's agent sees user help, not administrative or operator articles. Public Markdown and `/llms.txt` exports remain available without an MCP grant; they contain public documentation, not private workspace content.

## Plugin tools

A plugin your admin installed can add tools, such as the [calendar](/docs/calendar)'s `list_events` and `create_event`. Each plugin asks for its own permissions on the consent screen (**Read data in the Calendar plugin**, **Add and change data in the Calendar plugin**). Approve them only for the plugins you want the agent to use. A connection approved before the plugin was installed does not have them, and the older general plugin permissions do not cover new plugins: authorize again. The tools appear only while you can use the plugin, and they act with your permissions on it.

## Let your socio request external tools

In **Settings → Account → Profile**, find **External MCP connections**. Add a public HTTPS MCP server and choose OAuth or a public server with no authentication. Creating a connection does not itself grant tools. Review the provider identity and requested permissions, authorize when needed, then refresh and inspect its tool catalog.

Select a socio and specific supported tools, and save its tool access. These grants belong to your account; other people do not inherit your connection through a shared socio. Refreshing a catalog clears existing grants so you can review changed definitions. Every external call needs manual approval and cannot be undone here. Interrupted calls are not automatically repeated.

## Compatibility and disconnection

Support depends on the provider's actual protocol, authorization and tool schemas. A saved URL or successful discovery is not proof that every provider works. Test a provider deliberately with a bounded action you understand.

Disconnecting an external connection clears Socio's credentials and grants. Revoke the provider's authorization there as well when needed. Keep tokens and callback URLs out of shared issues and pages. See [Approvals](/docs/approvals) and [privacy](/docs/privacy) before enabling consequential tools.
