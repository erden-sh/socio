# Socio app release notes

What each TestFlight build asks testers to check, newest first. Each upload sets its entry as the
build's "What to Test" in TestFlight (AGENTS.md, Versions). An entry is `## <version> (build <number>,
<YYYY-MM-DD>)`, or `(build pending)` until it is uploaded, then a short **What to test** list in plain
words, grouped by screen.

## 0.2.7 (build 3806, 2026-11-26)

Your three notes on 0.2.6, editing in datasets, and a newer foundation under the app.

**What to test**

Your notes

- Pictures on an issue: open one, then pinch or double-tap to zoom in, drag to move around while zoomed, and double-tap again to fit. With several pictures, swipe sideways to go to the next one.
- In the same viewer, drag a picture down to close it: the issue shows behind it. A short drag springs back.
- Search for something that matches nothing: a "No results" message shows in the middle of the screen with a Clear search button. A Space's page search, the Board and Schedules do the same, with Clear filters when filters are on.

Datasets (where the workspace has them switched on)

- In a table view, tap a cell to edit it. Dates use the phone's date picker.
- Add a row, change a field, and export a view as CSV through the share sheet.
- Change a view's layout or filters and save it for everyone while someone else saves the same view: the app shows their version beside yours, with Keep mine, Take theirs or Save mine as a new view.
- Edit a cell someone else just changed: the app shows their value and lets you choose.

Chats and rooms

- Send photos and files in a chat and in a room, then reopen them: they still show, along with older ones.
- Message times, who wrote each room message, and the details of a failed turn still show.

## 0.2.6 (build 3711, 2026-11-22)

Your two notes on 0.2.5, and the first part of datasets in Spaces.

**What to test**

Your notes

- Settings: at the bottom, under the app's version, a line shows the server's version, such as "Server: Socio v0.51.0 (3f08741)". Tap the footer to copy all three lines.
- In a chat, expand "Working · N steps" while a socio works: the steps sit closer together. Finished turns keep their spacing, because each step there is a button.

Datasets in Spaces (where the workspace has them switched on)

- Datasets show in a Space's tree next to its pages, and datasets in no Space are in a Private group at the top of Spaces.
- Space editors can move a dataset.
- Opening a dataset lists its tables and views. Views open once the server serves them.

## 0.2.5 (build 3687, 2026-11-22)

Ask a socio about a page, more room in chats, and less noise.

**What to test**

Page conversation

- Open a page in Spaces and tap the speech bubble in its top bar ("Ask about this page"). With several socios, pick one from the menu.
- Ask it something about the page, or to change it (for example, make a subpage for each linked tool). The chat shows "Working on <page>"; tap it to go back to the page.
- Back on the page, the socio's changes and new subpages show.

Chats and rooms

- Opening a chat, a room or New chat hides the tab bar. Back returns to the list with the bar.
- In a room, the line under the message box is gone.
- While a socio works, only one "Thinking" or "Working" shows: the chat's own line, or the pill when that line is out of view. "Jump to latest" no longer sits on top of it.

Approvals (with Socio v0.51.0 on the server)

- When a socio needs your OK, for example to import linked pages, it shows the approval card in the chat instead of asking you to type.

## 0.2.4 (build 3648, 2026-11-21)

Two of your notes on 0.2.3: rooms you can make in the app, and Board columns you can swipe.

**What to test**

New room

- In Chats, tap the compose button: it's now a menu with New chat and New room.
- New room: give it a name, add socios and people (several of each), then Create. The room opens in Chats. The first socio leads; other socios wait for an admin's approval, as on the web. People get an invite.
- Home's Rooms › New room opens the same form instead of the browser.
- Offline, the form says it needs a connection and sends nothing.

Board

- On the Issues Board, swipe left and right on the cards to move between columns. The chips follow, and up-and-down scrolling still works.
- On the Board, Back works by swiping from the left edge.

Fixed

- Android: creating a Space no longer crashes the app.

## 0.2.3 (build 3604, 2026-11-21)

Your note on 0.2.2, plus native motion.

**What to test**

Your note

- Start a new chat and type with the keyboard up: the message box sits right on the keyboard, whole, with its + and Send. There's no blank band above the keyboard.
- Type three or four lines: the box grows with the text instead of scrolling inside one line.

Motion

- Swipe the workspace drawer open and closed: it follows your finger and settles with a spring at your swipe's speed.
- Turn on Settings › Accessibility › Motion › Reduce Motion: the drawer and other animations jump straight to their end.

Better since 0.2.2

- After opening and closing Search, Home, Spaces and More come back at their top. A Space's page can still come back scrolled down (CB-462).

## 0.2.2 (build 3584, 2026-11-20)

Tabs that keep their place, a Spaces tab, and your two notes on 0.2.1.

**What to test**

Tabs

- The tab bar is Home, Chats, Spaces, More, plus Search.
- Open a chat, a page or an issue: the tab bar stays visible.
- Switch tabs and come back: each tab is where you left it.
- Tap the tab you're on: it goes back to its top.
- Search opens with the iPhone's own search field.

Spaces

- Pages changed elsewhere while your edits waited show at the top of the Spaces list. The Spaces tab's badge counts them, and the Chats badge no longer does.
- Edit a page, then go back: the Spaces list should be at its top, not scrolled under the bar.

Your notes

- "Jump to latest" floats over your messages as clear glass, with the text showing through. While a reply runs, the "Working" pill floats beside it.

Known issue: on iPhone, opening Search from Spaces and closing it can leave the Spaces list scrolled down. Tapping the Spaces tab fixes it (CB-462).

## 0.2.1 (build 3572, 2026-11-20)

Your TestFlight feedback from 0.2.0, plus SF Symbols, iPhone buttons and system colors.

**What to test**

Your feedback

- In Chats, swipe a row open, then scroll up and down: scrolling should keep working, and the open row should close. Only one row opens at a time.
- The Archive and Delete circles and their labels should fit inside the row.
- The Inbox tab is gone. Approvals, changed pages, invites and unread rooms show at the top of Chats, and the Chats tab shows a badge with their count.
- In a new chat, the space above the first message should match the space on the sides.
- "Jump to latest" and the "Working" pill shown during a reply are now Liquid Glass.

Icons, buttons and colors

- Icons everywhere are the iPhone's own (SF Symbols).
- Buttons are iPhone capsules in Socio's teal.
- Backgrounds, text and separators use the iPhone's own colors. In light mode, gray secondary text is Apple's standard gray, a little lighter than before: say if it reads too faint.
- Turn on Settings › Accessibility › Display & Text Size › Increase Contrast: colors should get stronger everywhere.

## 0.2.0 (build 3553, 2026-11-20)

Bigger iPhone text, Apple-style lists, swipe actions and pull to refresh. New since build 3520 first.

**What to test**

Text

- Text everywhere is the iPhone's own sizes: chat messages and list rows are larger, and big page titles are bold. Turn up the text size in iPhone Settings › Display & Brightness › Text Size and check a few screens still read well.

Lists

- Chats is a plain list like Messages. Settings looks like the iPhone's Settings app, in grouped boxes.
- A socio's page, Spaces, the Inbox and an issue's fields are grouped boxes too.
- Pull down on Chats, Inbox, the Board, Spaces, a Space, Memories, Approvals or Activity to refresh it.

Swipe actions

- In Chats, swipe a chat to the left: Archive (a full swipe archives it, with Undo) and Delete (asks first).
- Swipe an unread room to mark it read.

Switches

- Settings' Light / Dark / System, the Board's board/list toggle, a Space's tabs and Schedules / Jobs use the iPhone's own segmented control. Runs' filter is a menu.

Chats

- Under a reply, open "Worked for … · N steps" in a long chat: the row should stay where you tapped it, with the steps opening below.

Issues

- File an issue has a "Plugins and apps" row: pick which plugins or apps it's about (needs the latest server). Admins can change them on the issue page; the Board's Filters has a Component filter, and cards show the tags.

Also in 0.2.0, if you haven't tried them in 3516 or 3520: the iPhone's own top bars, long-press and ⋯ menus, swipe-down sheets, the page editor's keyboard bar (please check it on a real iPhone), Home's socio rows and socio page, and the iPhone's own rename box.

## 0.1.0 (build 3520, 2026-11-19)

**What to test**

- Home: the top bar is one row with the workspace name, and the New chat button is gone. Tap a socio's row to open its page; the pencil next to it starts a chat.
- Module pages start with a small colored tile and a line about the page.
- Renaming a chat, Save as page and New page use the iPhone's own text box.

## 0.1.0 (build 3516, 2026-11-19)

**What to test**

- Every page uses the iPhone's own top bar: big titles on lists that shrink as you scroll, and the system Back.
- Long-press menus and ⋯ menus are the iPhone's own. Pickers open as sheets you can swipe down.
- The page editor: its top bar, a title that scrolls with the page, and the formatting bar on top of the keyboard.
- Chats: links open inside the app, file chips show their size, your own messages show formatting.
- Swipe down to hide the keyboard; tap Search again to type.
- Also new: New Space, Attach on an issue, Select and a list view on the Board, the reply action row, and "Welcome back." on sign-in.
