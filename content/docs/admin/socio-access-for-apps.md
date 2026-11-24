---
title: 'Socio access for apps'
description: 'Let socios use a mini app for the person they act for, and decide what each action needs.'
---

Socio access lets a socio open a mini app or plugin for the person it acts for: read a dashboard, update a record, or ask to send a message. The socio never gets the person's sign-in. It uses the app through Socio, under a grant the person approved, for a limited time, and every step is recorded.

It is off unless the **Socios use apps for you** feature (`socio-actor-access`) is on in [Settings → Features](/docs/admin/features), for everyone or for some people. Turning it off for someone ends their socios' access at once.

## Adopt the contract

A socio can only open an app that declares the delegation contract in its manifest. For any other app, the socio is told "this app hasn't adopted socio access; its owner can add it". The app must also check, on every request, who it is for and whether that action is allowed. The Socio app SDK (`@socio/app-sdk`) does this; its developer reference covers the code and a contract test kit for the app's own tests.

```json
{
    "delegation": {
        "contract": 1,
        "actions": {
            "deals.list": "read",
            "deal.update": "write",
            "sms.send": "consequential",
            "settings.update": "admin"
        },
        "public": ["/healthz", "/assets/"],
        "alwaysAsk": false,
        "background": { "datasets": ["deals"], "read": true },
        "spaceAccess": { "deals": "write" }
    }
}
```

- `contract`: always `1`.
- `actions`: each thing the app does, by name, with its tier. Apps don't invent permissions; tiers decide what a socio needs. Names starting with `data:` are reserved for Socio.
- `public`: paths the app serves without knowing who asks (a health check, static files). A path ending in `/` covers everything under it.
- `alwaysAsk`: always show the person the access card (below).
- `background`: datasets the app's own jobs may write while no one is using it, and whether they may read without a person.
- `spaceAccess`: what Space members may write through the app, per dataset.

Rows belong to nobody yet. Everyone who can open the app sees the same rows through it, and a socio acting for a person sees what that person would. An app that needs per-person rows must filter by the person id each request carries. A manifest that names `ownerColumn` is refused until row ownership ships.

## The four tiers

| Tier            | What it is                                                            | A socio needs                                            |
| --------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| `read`          | Looks, changes nothing                                                | read access                                              |
| `write`         | Changes the app's own data                                            | write access                                             |
| `consequential` | Spends money, sends a message, deletes in bulk, reaches outside Socio | act access, and a card for each action the person clicks |
| `admin`         | The app's settings, sharing, bulk export, key rotation                | never possible                                           |

When a socio first asks to use an app, the person sees an access card for read, write or act access, for a set time (at most 8 hours, ended sooner after 30 idle minutes). Read access may skip the card if the person opted in for that socio. Write and act access always show it, and only the person can approve.

With act access, each consequential action still shows its own card with the app, the action and its exact parameters. The person clicks Allow for that one call; it runs once. Changed parameters need a new card. Installed plugins that declare the contract work the same way: their consequential actions show the same card, naming the plugin as installed in your workspace. Deleting rows, tables, datasets or files through a socio works the same way: the person approves that exact delete. (Apps can't delete through the data API yet; when they can, this is how a socio's delete is approved.)

`admin` actions are never a socio's, whoever it acts for, and never a Space member's: only the app's owner, in person.

## Always ask

A person can let a socio they trust read apps without a card each time (**Reading without asking** in **Settings → Account → Socio access**). Set `alwaysAsk: true` for sensitive apps, such as HR or finance, to show the card on every access request regardless.

`alwaysAsk` is part of the version's action set. Turning it on in a new version suspends grants made under the older version until people approve again.

## Background datasets

Writes through the data API need a person behind them: the request the app is handling. Without one, the app may write only to its `background` datasets, for its own scheduled work, and never a consequential operation such as a delete. Reads without a person are allowed unless `background.read` is `false`.

## Space access

A Space member who opens a shared app may read its datasets through it. List a dataset under `spaceAccess` with `write` to let members, and socios acting for them, write it too. Without an entry it is `read`. The app's owner may do everything the app may.

## Repository extractions

A published app can take read-only copies of part of a repository listed under **Settings → Coding → Repositories** with **Extraction** on, for example to pack code for review. The app declares `"accepts": ["repo-extract"]` in its `delegation` block. Each extraction is the person's approval of one repository, one commit, its paths and that app (or falls under a standing grant they made), and only that app reads it, through Socio, during a request of that person. The app gets the files' contents only: no GitHub access, nothing else from the repository, no pushes. Development apps and service plugins can't take extractions.

## Published and development apps

Delegated access runs only code nobody sharing a computer can change:

- A company socio can use published (promoted) apps and installed plugins only. For an app still in development it says "promote the app first".
- A person's own socio can also use that person's own development apps, for that person only. Its shell can rewrite those apps, so the access levels there are advisory: the card says so, and the boundary is the person's trust in their own socio.

## Changing the action set

Adding, removing or re-tiering an action, or changing `alwaysAsk`, changes the version's action set. When that version goes live, grants made under the older one are suspended. The socio asks again and the person sees a new card.

Unpublishing, unregistering, deleting or unsharing the app ends its grants.

## See and end access

- People see the access they gave under **Settings → Account → Socio access**, choose there under **Reading without asking** whether a socio may read apps without a card, and end any grant with **End access**.
- Admins see every live grant (which socio may use which app, for whom) under **Operations → Socio access**, and can end any of them. Ending one is recorded with the admin's name. Admins can end access but can't approve on someone else's behalf.

Both appear only while the feature is on. In a Telegram group, socios refuse with "ask me in a private chat". Approvals and their history are on the person's [Approvals](/docs/approvals) page.
