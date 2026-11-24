---
title: 'Socios administration'
description: 'Set clear specialist roles, document access and computer permissions.'
---

## Define a useful specialist

Give a socio a recognizable name and role instructions that explain its purpose, preferred sources and how to handle uncertainty. They become version 1 of its Soul. Select its default Space for page creation and add only the Spaces it needs. A page conversation uses that page's Space as its default destination; a role instruction alone cannot authorize another Space. A private Space is used only in chats where everyone can see it, and a person can give their own socio only Spaces they can see.

Its **Character** (one of the Socio cast) is how it looks in the sidebar, chats and notifications. Several socios may share one, and changing it changes nothing about what the socio can do. Owners can change their personal socios' characters; admins can change any socio's, and each change is in the socio's audit.

Review research, memory, issue-filing, Learning and inference settings alongside the role. They affect what a socio can do and which model or published skills it can use. Do not put provider credentials or personal secrets in instructions: those instructions are model context.

## Souls

A socio's Soul is its versioned persona: role and standing instructions, plus optional voice, values and working style. Edit it on the socio's **Soul** page (its home page, its menu, or the **Soul** link of the socio on the admin **Socios** page). Admins edit workspace socios' Souls. A personal socio's Soul is its owner's to edit: admins can read it and its history, but not change it, including through the settings API. A socio can never change a Soul.

Each save or restore is a new version with who made it and when; earlier versions are never changed or removed. Restore puts an earlier version back as a new version. The socio's audit records each change as `Soul v3` or `Soul v3 (restored v1)`, never its text. The Soul goes in the system prompt, so it changes the prompt only when edited: a Soul of standing instructions alone reads exactly as the old role instructions did. It shapes tone and role and never overrides Socio's rules, permissions or approvals.

## Choose personal or workspace at creation

Creation is personal by default for every role, including admins. Use **Share with the workspace** only when the specialist is intended for the team. The form explicitly changes its visibility explanation. Members have no sharing switch and cannot force a workspace socio through a request.

The saved **Personal** or **Workspace** badge is the useful visibility check. Existing workspace socios remain shared after an upgrade. Editing settings preserves the ownership already stored; it does not convert an existing socio between personal and workspace.

Admins intentionally retain management authority over personal socio settings, including another person's. That authority does not give them the person's chat ownership, private conversation history, personal Data namespace or the right to edit the socio's Soul. A socio being absent from your normal sidebar is not proof that its settings are outside administrative management.

## Computer capabilities

Browser, workspace-file and shell permissions start disabled and are checked by the server. Enable the smallest set needed. The deployment must also provide a compatible computer service; enabling a switch does not install it. No permission means no fallback to the application host's shell or files.

A workspace socio's computer has shared facilities, including browser state and its shared working area. Current shell/file operations use per-person private homes, with explicit collaborative files under `shared/`; that does not make browser sessions personal. Use a personal socio when isolation is required, and review [privacy](/docs/privacy) with users before enabling tools.

## Review over time

Use history and audit information to understand who changed a capability. Archive retired specialists instead of silently repurposing their identity. Keep Learning scope assignment separate from published-skill delivery, and confirm your shared inference setup before expecting background work. See [Learning](/docs/admin/learning) and [Settings](/docs/admin/settings).
