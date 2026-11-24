---
title: 'Sign-in and code access'
description: 'Narrow sign-in methods and allowlists in the app, under the environment as the ceiling; give code access with groups.'
---

**Settings → Access** is for admins, in person. It lets you narrow, without a redeploy, what the server's environment allows: who may create an account, how people sign in and who is an admin by email. Admins and members don't see it, and socios and connected agents have no tool for it.

## Who may run code

Running code (coding sessions, and the coding gateways for models and Git) is a permission, not an environment list. Admins have it. Anyone else gets it from a group that gives **Run code**, under **Settings → People → Groups**, which every admin can manage:

- **New group** names a group and chooses its permissions. **Run code** is the only one for now.
- Add people to a group, or remove them, from the group's card or from a person's page, which lists their groups.
- **Edit** renames a group or changes its permissions; **Delete** removes it.

Each change applies at once: the next check sees it. Removing someone from a group, deleting the group or taking **Run code** off it means they can't start a coding session or use the gateways from then on.

`CODE_USERS` is deprecated. On the first boot with groups, if it (as narrowed on this page before) listed anyone, the people on it who aren't admins were put in a group called **Code**. That happens once: deleting the group later doesn't bring it back. The server logs a deprecation warning while `CODE_USERS` is set; remove it from the stack env. A later release stops reading it.

## The environment is the ceiling

The page can only take away. You can:

- turn **Email and password**, **Passkeys**, **Sign-in links by Telegram** or **Open sign-up** off, when the environment has them on;
- turn a configured sign-in provider off;
- untick entries of the **Admin emails**, **Allowed emails** and **Allowed domains** lists.

You can't add a method, a provider, an email or a domain here. Those still go in the environment (`AUTH_*`) with a stack update. What is in force is always the environment's value narrowed by what was saved. If the environment drops an entry, it is gone whatever the page saved. If the environment adds one while a narrowed list is saved, the new entry stays off until you tick it. A list with every entry ticked follows the environment.

A method the environment itself turns off makes no new sessions, but only the page ends sessions. Restarting without the Telegram bot doesn't sign out people who came in with a link.

## Making a change

1. Change the ticks. The page shows what the change would do: the changes in words, how many sessions end, who would be left without a way to sign in, whether you would be signed out, and how many code runs stop.
2. Choose **Review and confirm**, then confirm with your password or a passkey. Each confirmation covers exactly that change, once, for five minutes, in this browser session. If someone else saved a change in the meantime, you are asked to reload.
3. Every admin gets a notice, and the change goes into the page's **History**, which can't be edited.

Confirming needs a password or a passkey that is on. If you sign in only with a provider or a Telegram link, add a passkey under **Settings → Profile** first. Five wrong confirmations in 15 minutes lock confirming for the rest of that time, and every admin is told.

## What ends when you narrow

- Sessions that began with a method you turn off end at once, and their next request asks them to sign in again.
- People left without any way they have set up (no password, passkey, provider or reachable Telegram link that is still on) lose their sessions too. The preview names them.
- Taking an email off **Admin emails** makes that person a member at their next request, unless their own role is admin. Operators are never demoted by a list.
- Narrowing **Allowed emails**, **Allowed domains** or **Open sign-up** only affects who may create an account. Existing accounts keep signing in.

## Lockout protection and the break glass

The page refuses a change that would leave no way to sign in, leave you without a method you have set up, leave no active admin able to confirm a later change, or leave the workspace owner without a way to sign in.

If no admin can get in anyway (for example, a passkey was lost after the change), run this on the server with the app service's environment:

```sh
node dist/server/server/auth/auth-cli.js access-policy         # what is narrowed
node dist/server/server/auth/auth-cli.js access-policy-reset   # the environment applies again
```

The reset goes into the history as `cli`. Tell the admins that you used it.

## Backups and restores

The saved policy and its history live in the database, so a restore brings back the policy as it was then. It can never go beyond the environment, but it can undo a tightening. After a restore, open **Settings → Access** and check it. The boot log also says what is narrowed and since when. If you restored because of a suspected compromise, rotate `SESSION_SECRET` too, which signs everyone out (see [Secrets](/docs/operate/secrets)).
