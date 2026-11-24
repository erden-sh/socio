---
title: 'Model costs and price sync'
description: 'How Operations prices turns, what the daily price sync downloads, and how to cost self-hosted backends.'
---

Operations → **Cost** shows what turns cost over the chosen range: by model, socio, person and backend, the turns that have no price, the cost pools of self-hosted backends with their idle capacity, and the prices behind every number. Admins and operators see it; viewing spend by person is written to the access log.

## Where prices come from

Each turn is priced at its backend's provider's price for its model, in force when the turn started, in US dollars per million tokens. Three kinds of price exist, and the first one that applies wins:

1. **An admin's price**, from its date onward. Use provider `*` for a price that holds for every provider, such as a self-hosted model.
2. **A provider's own price list**: OpenRouter, DeepInfra, Azure Retail Prices (Foundry Models in East US 2) and the AWS Price List (Bedrock in us-east-1).
3. **A community list**: models.dev and LiteLLM's price list.

A turn whose model has no price shows as **unpriced**. Its cost is unknown, never counted as zero. **Models without a price** on the Cost page lists them, and **Add a price** fills in the form.

## The daily price sync

With **Price sync** on (Operations → Settings), Socio downloads each list once a day, keeps the prices of the models in use and stores a new row only when a price changes. A list that fails is tried again an hour later; each list's last run shows under **Price sync** on the Cost page, and **Sync now** runs one at once.

The requests are plain downloads of public lists. They carry a generic user agent (`research-script/0.1`) and nothing about the workspace, its people or the server, and go only to the lists' own hosts. Lists that need an API key are not read.

The switch is admin-editable over the server's default, `OPS_PRICE_SYNC` (`on` or `off`). When unset it is on in the production image and off in development. Turn it off for an offline install: then no list is read, and turns are priced with the prices already kept and admins' own. `OPS_PRICE_SYNC_URL` points every download at another origin, path and query kept, for an internal mirror. Each change to the switch is written to the workspace audit.

## Self-hosted backends: cost pools

A self-hosted backend has no list price. Describe what it costs as **cost pools**:

- **Fixed**: an amount per hour, day, month or year (hosting, a lease), or a purchase price written off in a straight line over a number of months (hardware).
- **Metered**: meter readings, such as kWh of power. Each reading is the use since the one before, at its own unit price or the pool's.
- **Subscription**: a fixed pool over ChatGPT connections. Its numbers are labeled estimates.

Each hour's cost is shared among that hour's turns on the pool's backends by weighted tokens (uncached input 1, cached input 0.1, output 4, editable per pool). Hours without turns are **idle capacity**. Allocated plus idle always equals the pool's cost for the range. The Backends table puts each self-hosted backend's pooled cost per million tokens beside the cheapest listed cloud price for the same turns.

Pool costs start from the oldest turn the analytics store holds. Turns recorded before this release don't say which shared backend served them. They are matched to the one backend that serves their model, otherwise they show as "a shared backend (older turns)".

## After an upgrade

This release adds operations migration 4 (model prices and cost pools) and rebuilds the analytics store once (ETL version 6). Take a [paired backup](/docs/operate/backups) first. An older image refuses the migrated database, so rolling back means restoring that backup.
