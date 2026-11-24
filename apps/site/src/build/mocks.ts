import { icon } from './icons.ts';
import { m, sq } from './layout.ts';

// The drawn app on the home page: a browser window with a room, and phones (Home, a room, an
// approval, the board). Made-up content only (Coral Street Studio, Ada and Ben, example.test);
// a later screenshot session replaces them with real shots from the fake servers.

const STATUS = `<div class="island"></div><div class="status"><span>9:41</span><span class="ic">${icon('signal')}${icon('wifi')}<span class="batt"></span></span></div>`;
const TABS = (on: string) =>
    `<div class="p-tabs"><div class="bar">${[
        ['house', 'Home'],
        ['messages-square', 'Chats'],
        ['inbox', 'Inbox'],
        ['ellipsis', 'More'],
    ]
        .map(([ic, l]) => `<span class="tab${l === on ? ' on' : ''}">${icon(ic)}${l}</span>`)
        .join('')}</div><span class="search">${icon('search')}</span></div>`;

export const phoneHome = () => `<div class="phone"><div class="screen">${STATUS}<div class="content">
  <div class="p-head"><span class="wsicon">${m('sebas')}</span><b>Coral Street</b>${icon('chevron-down', 'chev')}<span class="av ada me">A</span></div>
  <div class="p-tiles">
    <div class="p-tile">${sq('orange', 'list-todo')}<b>Board</b><span>7 open</span></div>
    <div class="p-tile">${sq('sky', 'folder')}<b>Spaces</b><span>3 spaces</span></div>
    <div class="p-tile">${sq('violet', 'calendar-clock')}<b>Schedules</b><span>4 tasks</span></div>
  </div>
  <div class="p-sec">Socios <span>3 on the team</span></div>
  <div class="p-list">
    <div class="p-item">${m('sebas')}<div class="t"><b>Sebas</b><span>Drafting the spring newsletter</span></div><span class="state busy"><i></i>Working</span></div>
    <div class="p-item">${m('manny')}<div class="t"><b>Manny</b><span>Keeps the client list tidy</span></div><span class="state"><i></i>Idle</span></div>
    <div class="p-item">${m('mingo')}<div class="t"><b>Mingo</b><span>Bookings and the calendar</span></div><span class="state"><i></i>Idle</span></div>
  </div>
  <div class="p-sec">Rooms</div>
  <div class="p-list">
    <div class="p-item">${m('sebas')}<div class="t"><b>Spring launch</b><span>Ben: Looks great, ship it Thursday</span></div></div>
    <div class="p-item">${m('mingo')}<div class="t"><b>Front desk</b><span>Mingo: 3 bookings moved to Friday</span></div></div>
  </div>
</div>${TABS('Home')}</div></div>`;

export const phoneRoom = () => `<div class="phone"><div class="screen">${STATUS}<div class="content">
  <div class="p-nav">${icon('chevron-left')}<div><b>Spring launch</b><span>Sebas leads · 4 members</span></div><span class="r">${m('sebas')}${m('manny')}<span class="av ada">A</span><span class="av ben">B</span></span></div>
  <div class="thread">
    <div class="msg me"><div class="bubble"><span class="mention">@Sebas</span> draft the launch email for Thursday, and <span class="mention">@Manny</span> check who should get it.</div></div>
    <div class="msg"><img class="who" src="/art/sebas.svg" alt=""><div class="body"><div class="name">Sebas <span>9:12</span></div><div class="text">On it. Three subject lines below; I’d go with the first.</div>
      <div class="mini-card"><div class="h">${sq('sky', 'file-text')}Launch email, draft 2</div><ul><li>Spring menu is here ☀️</li><li>New season, new tables</li></ul></div></div></div>
    <div class="handoff">${icon('arrow-left-right')}Sebas handed the list to Manny</div>
    <div class="msg"><img class="who" src="/art/manny.svg" alt=""><div class="body"><div class="name">Manny <span>9:14</span></div><div class="text">248 customers opted in. I left out 12 who unsubscribed in March.</div></div></div>
    <div class="msg"><span class="who av ben">B</span><div class="body"><div class="name">Ben <span>9:20</span></div><div class="text">Looks great, ship it Thursday 🙌</div></div></div>
  </div>
  <div class="composer">${icon('plus')} Message the room<span class="send">${icon('arrow-up')}</span></div>
</div></div></div>`;

export const phoneApproval = () => `<div class="phone"><div class="screen">${STATUS}<div class="content">
  <div class="p-nav">${icon('chevron-left')}<div><b>Approval</b><span>Waiting for you</span></div></div>
  <div class="p-approval-hero"><span class="badge t-amber">${icon('shield-check')}Needs your approval</span><div class="who tw:mt-[10px]">${m('sebas')}<div><b>Sebas</b> wants to<div class="muted tw:text-[11px]">Spring launch · 2 min ago</div></div></div>
    <h5>Send “Spring menu is here” to 248 customers</h5></div>
  <div class="p-kv"><div><span>Tool</span><b>Newsletter · send</b></div><div><span>Audience</span><b>Opted-in customers</b></div><div><span>When</span><b>Thu, 9:00 AM</b></div></div>
  <div class="p-preview"><div class="subj">Spring menu is here ☀️</div><p>Hi there, our spring menu starts Thursday: citrus salads, a new cafecito flight and longer patio hours…</p></div>
  <div class="p-actions"><span class="no">Decline</span><span class="ok">Approve</span></div>
</div></div></div>`;

export const phoneBoard = () => `<div class="phone"><div class="screen">${STATUS}<div class="content">
  <div class="p-nav">${icon('chevron-left')}<div><b>Board</b><span>7 open · 2 in progress</span></div><span class="r tw:text-(--primary)">${icon('plus')}</span></div>
  <div class="p-segs"><span class="on">All</span><span>Mine</span><span>Socio requests</span></div>
  <div class="p-board-col t-sky"><i></i>Open <span>3</span></div>
  <div class="issue"><div class="top">CS-14 <span class="badge t-orange">High</span><span class="votes">${icon('thumbs-up')}4</span></div><b>Online booking skips the deposit</b><div class="kind">Bug${m('mingo')}</div></div>
  <div class="issue"><div class="top">CS-15 <span class="badge t-sky">Medium</span><span class="votes">${icon('thumbs-up')}2</span></div><b>Export the client list as CSV</b><div class="kind">Feature${m('manny')}</div></div>
  <div class="p-board-col t-amber"><i></i>In progress <span>2</span></div>
  <div class="issue"><div class="top">CS-11 <span class="badge t-rose">Urgent</span><span class="votes">${icon('thumbs-up')}6</span></div><b>Patio photos for the spring page</b><div class="kind">Task${m('sebas')}</div></div>
  <div class="issue"><div class="top">CS-12 <span class="badge t-sky">Medium</span><span class="votes">${icon('thumbs-up')}1</span></div><b>Shorter welcome email</b><div class="kind">Improvement${m('sebas')}</div></div>
</div>${TABS('More')}</div></div>`;

export const browserApp =
    () => `<div class="browser"><div class="chrome"><i></i><i></i><i></i><span class="url">${icon('lock')}coralstreet.example</span></div>
<div class="app">
  <div class="side">
    <div class="ws">${m('sebas')}Coral Street Studio</div>
    <div class="row">${icon('plus')}New chat</div>
    <div class="row">${icon('search')}Search<span class="r">⌘K</span></div>
    <div class="sec">Socios</div>
    <div class="row">${m('sebas')}Sebas</div>
    <div class="row">${m('manny')}Manny</div>
    <div class="row">${m('mingo')}Mingo</div>
    <div class="sec">Spaces</div>
    <div class="row">${icon('folder')}Studio handbook</div>
    <div class="row">${icon('folder')}Clients</div>
    <div class="sec">Rooms</div>
    <div class="row on">${icon('messages-square')}Spring launch</div>
    <div class="row">${icon('messages-square')}Front desk</div>
    <div class="sec">Workspace</div>
    <div class="row">${icon('list-todo')}Board<span class="r">7</span></div>
    <div class="row">${icon('shield-check')}Approvals<span class="r">1</span></div>
    <div class="row">${icon('book-open')}Memories</div>
  </div>
  <div class="main">
    <div class="bar">${icon('messages-square')}<b>Spring launch</b><span class="muted">· Sebas leads</span><span class="members">${m('sebas')}${m('manny')}<span class="av ada">A</span><span class="av ben">B</span></span></div>
    <div class="thread">
      <div class="msg me"><div class="bubble"><span class="mention">@Sebas</span> draft the launch email for Thursday, and <span class="mention">@Manny</span> check who should get it.</div></div>
      <div class="msg"><img class="who" src="/art/sebas.svg" alt=""><div class="body"><div class="name">Sebas <span>9:12 AM</span></div><div class="text">On it. I wrote it in the brand voice from the handbook and put three subject lines up top.</div>
        <div class="mini-card"><div class="h">${sq('sky', 'file-text')}Launch email, draft 2 <span class="muted tw:font-normal">· Studio handbook</span></div><ul><li>Spring menu is here ☀️</li><li>New season, new tables on the patio</li></ul></div></div></div>
      <div class="handoff">${icon('arrow-left-right')}Sebas handed the audience check to Manny</div>
      <div class="msg"><img class="who" src="/art/manny.svg" alt=""><div class="body"><div class="name">Manny <span>9:14 AM</span></div><div class="text">248 customers opted in. I left out 12 who unsubscribed in March.</div>
        <div class="approval tw:mt-2"><div class="h">${sq('amber', 'shield-check', 'sm')}Send “Spring menu is here” to 248 customers?</div><div class="t">Thursday 9:00 AM · Newsletter · asks Ada</div><div class="btns"><span class="ok">Approve</span><span class="no">Decline</span></div></div></div></div>
    </div>
    <div class="composer">${icon('plus')} Message the room — @ to bring in a socio<span class="send">${icon('arrow-up')}</span></div>
  </div>
</div></div>`;
