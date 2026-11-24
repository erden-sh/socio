---
title: 'Link cards and /unfurl'
description: 'Save the full source of a post, video or article to a page, with a static card.'
---

## Save a link to a page

Start a chat message with `/unfurl` and the link, for example `/unfurl https://x.com/someone/status/123`. The socio saves the whole source to a page: a card at the top, then the full text, who wrote it and when, and the links it contains. It saves the source itself, not a summary. To add it to a page you already have, ask in that page's conversation to add it here; otherwise the socio creates a new page in the Space you are working in, or the Space you name.

What it reads depends on the link:

- **X (Twitter) posts** are read through FixTweet, a public service that returns a post's text, author, date and media. A long-form X article comes with its whole text, and a quoted post with its text.
- **Videos and photos** from YouTube, Vimeo and other sites that offer oEmbed come with their title, author and preview image. The video itself stays on its site; the card links to it.
- **Articles and other pages** come with their main text: headings, paragraphs, lists, quotes and code. Navigation, ads and scripts are left out.

The socio needs permission to read the web. If it says it can't unfurl links, ask an admin to allow web research for that socio.

## What a card shows

A card is a snapshot taken when the link was saved: the site, author, title, an excerpt, up to four images, the date and a link to the original. It never changes afterwards and nothing on it loads from the linked site. There are no embedded players or third-party scripts on your page, and opening the page tells the linked site nothing. Use **Open on …** on the card, or the play button on a video, to see the original in a new tab.

In Markdown source mode a card is a fenced block marked `embed` that holds the card as JSON. Leave it as it is to keep the card. If you change it so it no longer reads as a card, it shows as a code block and its text stays.

## Media are copied to your Files

The card's images are copied into your **Media** files, in a folder named `unfurled/` and the site's name, such as `unfurled/x.com/`. For a video, its preview image is copied. The card shows those copies, so everyone who can read the page sees them. If you delete a copy from your files, the card shows a short note in its place. The copies count toward your storage like any other file.

Large images, images on private network addresses and anything that isn't an image are not copied. The socio tells you when that happens.

## How the link is read

The socio reads the link as Socio's declared agent, the same way it reads any public web page. Requests carry Socio's own User-Agent and nothing about you: no name, email, account or cookies. Only public addresses can be read, each site is rate-limited, and a site that refuses is left alone for a while instead of being retried. A site's text is treated as information to save, never as instructions to the socio.

See [Pages](/docs/pages) for editing documents and [Data and media](/docs/data-media) for your files.
