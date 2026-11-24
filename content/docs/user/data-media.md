---
title: 'Data and media'
description: 'Manage attachments, personal files, datasets and access grants.'
---

## Files and attachments

**Media** is the file browser for your personal data space. Upload with the button, a drop or paste; use folders, previews and downloads to organize material. Images show thumbnails, and a text preview may show only the beginning of a file. The list can identify the chat an attachment came from or the socio that saved a file.

Chat attachments upload into this same data space. A conversation stores a reference, not a second copy of the file bytes. Its socio may read material attached to that conversation without an additional folder grant. Other files need an appropriate grant. A model without image support cannot interpret an attached image as vision input; large or older images can be represented by notes instead.

## Move files and folders

Drag a file or folder onto another folder to move it there: onto a folder in the list, in the folder tree beside it, or on a breadcrumb above it. **All files** in the tree or the breadcrumbs moves it back to the top level. While you drag, the folders that can take it are outlined and the one under the pointer is highlighted. Press Esc to cancel a drag.

Without a mouse, use the **More actions** button (the three dots) on a file or folder and choose **Move to…**, then pick the folder. This works with the keyboard, a screen reader and on a phone or tablet, including for folders that the tree doesn't show while they are closed. Some phones also let you press and hold a file, then drag it.

A move tells you where the file or folder went, with **Undo** to put it back. Moving a folder takes everything in it along, and socios that have access to it keep that access. A few moves are refused: a folder into itself or one of its own subfolders, the **Socios** folder or a socio's own folder, a new folder directly in **Socios**, and a move that would put a file where one of the same name already is. Rename the file first, or pick another folder. If a folder of the same name is already there, the two folders are combined, and that move has no Undo.

You can move only your own files and folders. A file moved into a folder that a socio has access to becomes reachable by that socio, and one moved out of it stops being reachable through that folder; check a folder's **Socio access** before you move private material into it.

## Datasets and grants

**Data** holds datasets that socios can query and work with. A dataset is separate from the application's own database. You can inspect, query and export it, including CSV or SQLite where offered. In a CSV export, a value that a spreadsheet would run as a formula (it starts with `=`, `+`, `-`, `@`, a tab or a carriage return) begins with an apostrophe, so it opens as plain text. Binary columns are exported as base64 and get the same apostrophe when their base64 starts with `+`; to get the original bytes back, remove that one leading apostrophe before decoding. A socio has its own scratch area for you; additional datasets or folders need permission.

Review a folder's **Socio access** and give access only to the specialist that needs it. Sharing a dataset with a Space is a separate decision from writing about it in a page. New datasets, shared writes and access changes can require [approval](/docs/approvals). Moving or renaming a folder carries its grants; deleting a folder ends them.

## Shared computer areas are separate

Your personal Data namespace is not the same as a workspace socio's shared computer area. A workspace computer's data token is restricted to its shared area and permitted shared datasets, rather than your private files. To hand material to that shared computer, copy it deliberately into the shared area. Use a personal socio when private computer work is needed, and review [privacy](/docs/privacy).

## Deletion and limits

Deleting hides a file, attachment or dataset and stops normal access. It does not immediately purge retained encrypted bytes or backup copies. Replacing a file can retain an older version, so frequent large rewrites affect storage. A deleted attachment appears removed in its conversation; deleting a conversation does not necessarily remove the attachment from your files.

The workspace enforces upload, dataset and per-person limits. Lowering a limit does not delete existing data. If storage is unavailable, wait for recovery rather than repeatedly uploading duplicates. Ask an admin about quotas or retention when you need more space.
