---
title: 'Socio help'
description: 'Find your way from a first conversation to shared pages and ongoing work.'
---

Socio brings specialist AI assistants, called socios, together with your team's pages and work. Start with a small task whose result you can check. A socio can explain a document, prepare a draft, or propose a next step; tools and permissions determine what it can actually do.

## Start here

Follow [Getting started](/docs/getting-started) to choose a socio, send a message and find a shared page. Then learn how [chats](/docs/chats), [socios](/docs/socios) and [privacy](/docs/privacy) fit together. A personal socio, a private conversation and a shared page are different things.

## Work with your team

[Spaces](/docs/spaces) organize shared knowledge. [Pages](/docs/pages) hold the documents, and [page conversations](/docs/page-conversations) let you work with a specialist beside a document. [Rooms](/docs/rooms) (a preview) put several people and a company socio in one conversation. [Ask a socio](/docs/ask-a-socio) opens a conversation about the page, issue, dataset or schedule on your screen from anywhere. Saving a conversation as a page publishes saved conversation text into that shared knowledge, so review it first. [Link cards](/docs/link-cards) explain how `/unfurl` saves a post, video or article to a page.

For work beyond a single reply, use [goals](/docs/goals) or [schedules and jobs](/docs/schedules). Review consequential actions in [Approvals](/docs/approvals). Report a problem, request a feature or follow a decision on the [Improvements board](/docs/improvements). Try features before they are released with [Early access](/docs/early-access). When an admin has installed it, the [calendar](/docs/calendar) keeps the team's events.

## Your files and connections

[Data and media](/docs/data-media) explains personal files, attachments, datasets and sharing. [Voice calls](/docs/voice-calls) explains talking with a socio out loud. [Telegram](/docs/telegram) covers linking your account and the difference between direct messages and team topics. [Connected agents and external tools](/docs/connected-agents) explains connections into Socio and connections from Socio to another service.

Your role and the services configured by your team determine which controls appear. A missing feature may need setup or permission. Ask an admin with the screen name and the action you were trying to take; never send them a password, sign-in link or session cookie in an issue.

## Read help with an agent

Public help is also available as Markdown: `/docs.md` for this index and `/docs/chats.md`, for example, for an article. `/llms.txt` lists the help catalog and `/llms-full.txt` provides its text. Exports and search respect the reader's role: public requests include user help only. These are documentation exports, not exports of your workspace pages or conversations.

A connected agent can request the separate `docs:read` permission and use `list_docs`, `read_docs` and `search_docs`. Existing grants for issue or page access do not gain help-tool access automatically; the client must request the new scope and you must approve it explicitly. See [Connected agents](/docs/connected-agents) for the connection boundary.
