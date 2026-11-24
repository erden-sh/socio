---
title: 'Learning and skills'
description: 'Review conversation-derived procedures and keep them distinct from chat commands.'
---

## Learning for admins, Skills for members

The same module is called **Learning** for admins, who review proposals and evidence, and **Skills** for members, who see published procedures. Nothing derived from evidence is published without administrative review.

Assign a socio a Learning scope through **Manage scopes** or its Learning container setting. Multiple socios may share a scope. New conversations bind to the scope when created; changing a setting does not move old conversations. Leaving the scope blank stops collection from new conversations. Delivery of that scope's published skills is a separate switch.

## Analyze evidence

A conversation becomes eligible when its latest run finishes successfully. Failed or stopped runs remain ineligible until a later finished run. Analysis runs when enough new evidence is available, on its daily schedule, or when an admin chooses **Analyze now**. **Analyze now** is hidden until it is fixed: it shows only when an admin turns on the **Learning: Analyze now** feature in [Settings → Features](/docs/admin/features). It uses the default shared inference backend, not a person's subscription. A missing backend or no new evidence explains an unavailable Analyze button.

Analysis uses bounded recent transcript excerpts and asks for reusable procedures. Redaction removes some contact details and secret-like strings before sending evidence to the model. Proposals are still untrusted: inspect the instructions, evidence and rationale for private facts, unsupported claims and unwanted capabilities. Admins can see evidence from private conversations, so explain that policy to the team.

## Triage

**Learning triage** is off by default. An admin turns it on in **Operations → Settings**, where its threshold and daily cap of model calls also live. With it on, the workspace's model reads each finished conversation's title and what people asked in it, never the replies. That text is scrubbed of contact details and secrets and cut to 1,500 characters. The model says whether the conversation shows a procedure the team would repeat. Conversations it is sure are one-off stay out of the analysis, so less of the team's conversations goes to the model. It also checks each proposal, after Learning's own checks, for a repeat of a rejected or published skill and for private details. An analysis also starts early when one intent (from Operations' Session intent) recurs in five sessions of the new conversations.

The model's answers count only after it passes an evaluation against your own labels. On each container, the **Triage** list shows recent conversations with the model's score and intent. Mark each one **Shows a repeatable procedure** or **One-off**; an evaluation needs at least 20 such labels. Your label always counts and overrules the model's. Until the model passes, its triage is only shown, except that a proposal it is sure holds private details is still dropped. A run's line says how many conversations triage left out, why proposals were dropped, and the tokens and cost the analysis reported.

## Publish and revise

Open a proposal, edit its name, description and instructions, and compare it with an existing published skill when relevant. **Approve and publish** creates an immutable revision. **Reject** records that decision; **Revoke** stops delivering a published skill. Prior decisions inform later analyzes, reducing repeated proposals. **Deliver** can pin an earlier container revision for rollback; selecting the latest unpins it.

Publication supplies instructions to socios with delivery enabled. It does not install software or bypass Space, file, computer or approval permissions.

## Chat skills are separate

**Settings → Chat skills** manages commands people invoke with `/name`. Some apply for one message; others stay active until `/done` or End. Their revision history and source lock show where instructions came from.

GitHub imports are previewed at an explicit ref and resolved commit. Read the exact instructions and license before installing or updating. Only `SKILL.md` instructions are imported; referenced scripts, dependencies and permissions are not installed. Treat imported instructions as untrusted content. Members can invoke installed commands but cannot import or edit them. A skill that exceeds the available prompt budget fails visibly rather than silently expanding the model context.
