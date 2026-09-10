// App shell: loads a week, renders every panel from it, and sends writes back.
//
// There is one source of truth -- the payload from GET /api/week -- and one
// render path. Any action (logging steps, cheering, changing a goal) writes to
// the server and then re-fetches, rather than patching the DOM by hand. At this
// size that is both simpler and impossible to get out of sync.

import { api, fmt } from './api.js';
import { Track } from './track.js';

const el = (id) => document.getElementById(id);

let week = null; // the current payload
let viewedWeekStart = null; // null means "this week"
let avatars = [];
let hasCentredOnMe = false;

const track = new Track({
  gutter: el('trackGutter'),
  scroller: el('trackScroll'),
  inner: el('trackInner'),
  minimap: el('minimap'),
  viewport: el('minimapViewport'),
});

// ------------------------------------------------------------------- loading

async function load(weekStart = viewedWeekStart) {
  try {
    week = await api.week(weekStart);
    viewedWeekStart = week.weekStart;
    render();
  } catch (err) {
    el('weekLabel').textContent = err.message;
  }
}

function render() {
  const me = week.members.find((m) => m.isMe);

  el('groupName').textContent = week.group.name;
  el('weekLabel').textContent = week.isCurrentWeek
    ? `This week · ${week.weekLabel}`
    : week.weekLabel;
  el('profileBtn').textContent = me?.avatar ?? '🙂';

  // You can look back but not forward -- future weeks hold nothing.
  el('weekNext').disabled = week.isCurrentWeek;
  el('weekThis').disabled = week.isCurrentWeek;

  renderMyStatus(me);
  track.render(week);
  el('scaleNote').textContent = `${fmt(week.maxSteps)} steps wide`;
  renderDayGrid(me);
  renderBoard();
  renderGroup();

  // Centre on the viewer the first time only, so a refresh after logging
  // steps doesn't yank the track away from wherever they were looking.
  if (!hasCentredOnMe) {
    hasCentredOnMe = true;
    requestAnimationFrame(() => track.scrollToMe(false));
  }
}

// ----------------------------------------------------------------- my status

function renderMyStatus(me) {
  if (!me) {
    el('myStatus').innerHTML = '<p>Your account is not in this group.</p>';
    return;
  }

  const { paceDelta, paceTarget, total, weeklyGoal } = me;
  const onPace = paceDelta >= 0;
  const goalPct = Math.min(100, Math.round((total / weeklyGoal) * 100));
  const pacePct = Math.min(100, Math.round((paceTarget / weeklyGoal) * 100));

  const paceLine = onPace
    ? `${fmt(paceDelta)} ahead of your own target`
    : `${fmt(-paceDelta)} behind your own target`;

  const rivalChips = [];
  if (week.rivals.ahead) {
    rivalChips.push(
      `<span class="rival">⬆ ${fmt(week.rivals.ahead.gap)} behind ${
        week.rivals.ahead.avatar
      } ${escapeHtml(week.rivals.ahead.name)}</span>`
    );
  }
  if (week.rivals.behind) {
    rivalChips.push(
      `<span class="rival">⬇ ${fmt(week.rivals.behind.gap)} ahead of ${
        week.rivals.behind.avatar
      } ${escapeHtml(week.rivals.behind.name)}</span>`
    );
  }
  if (!rivalChips.length) {
    rivalChips.push('<span class="rival">Log some steps to join the race</span>');
  }

  el('myStatus').innerHTML = `
    <div class="mystatus__top">
      <div class="mystatus__avatar">${me.avatar}</div>
      <div>
        <div class="mystatus__name">${escapeHtml(me.name)}</div>
        <div class="mystatus__sub">
          ${ordinal(me.rank)} of ${week.members.length} · ${paceLine}
        </div>
      </div>
      <div class="mystatus__total">
        <b class="num">${fmt(total)}</b>
        <span>of ${fmt(weeklyGoal)} goal · ${goalPct}%</span>
      </div>
    </div>

    <div class="pacebar">
      <div class="pacebar__fill" style="width: ${goalPct}%"></div>
      <div class="pacebar__notch" style="left: ${pacePct}%"
           title="Where you should be by ${
             week.isCurrentWeek ? 'today' : 'the end of the week'
           }"></div>
    </div>
    <div class="pacebar__legend">
      <span>${onPace ? '✅ On pace' : '⚠️ Behind pace'}</span>
      <span>Target ${week.isCurrentWeek ? `day ${week.daysElapsed}/7` : 'full week'}: ${fmt(
        paceTarget
      )}</span>
    </div>

    <div class="rivals">${rivalChips.join('')}</div>
  `;
}

// -------------------------------------------------- my week (the backfill grid)

function renderDayGrid(me) {
  el('dayGrid').replaceChildren(
    ...week.dates.map((day) => {
      const cell = document.createElement('div');
      cell.className = 'daycell';
      if (day.isToday) cell.classList.add('daycell--today');
      if (day.isFuture) cell.classList.add('daycell--future');

      const label = document.createElement('div');
      label.className = 'daycell__day';
      label.textContent = day.isToday ? 'Today' : day.dayName;

      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '200000';
      input.step = '100';
      input.placeholder = day.isFuture ? '–' : '0';
      input.value = me?.days[day.iso] ?? '';
      // Past weeks stay editable -- people forget to log until Monday -- so
      // this only ever blocks days that haven't happened yet.
      input.disabled = day.isFuture;
      input.setAttribute('aria-label', `Steps for ${day.dayName}`);
      if (me?.days[day.iso] !== undefined) input.classList.add('is-saved');

      input.addEventListener('change', () => saveDay(day.iso, input));
      // Enter should commit and move on, like a spreadsheet.
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') input.blur();
      });

      cell.append(label, input);
      return cell;
    })
  );

  el('myWeekHint').textContent = week.isCurrentWeek
    ? "Forgot a day? Just type it in. You can only ever edit your own row."
    : `Editing a past week (${week.weekLabel}). Corrections are still allowed.`;
}

async function saveDay(dateISO, input) {
  const raw = input.value.trim();
  const note = el('saveNote');
  note.classList.remove('savenote--error');

  try {
    if (raw === '') {
      await api.clearDay(dateISO);
      note.textContent = 'Cleared';
      input.classList.remove('is-saved');
    } else {
      const steps = Number(raw);
      if (!Number.isInteger(steps) || steps < 0) throw new Error('Whole numbers only, please.');
      await api.logSteps(dateISO, steps);
      note.textContent = 'Saved ✓';
      input.classList.add('is-saved');
    }
    await load();
  } catch (err) {
    note.textContent = err.message;
    note.classList.add('savenote--error');
    return;
  }

  setTimeout(() => {
    if (!note.classList.contains('savenote--error')) note.textContent = '';
  }, 2000);
}

// --------------------------------------------------------------- leaderboard

function renderBoard() {
  const medals = ['🥇', '🥈', '🥉'];

  el('board').replaceChildren(
    ...week.members.map((member) => {
      const row = document.createElement('li');
      row.className = 'board__row';
      if (member.isMe) row.classList.add('board__row--me');
      if (member.isGhost) row.classList.add('board__row--ghost');
      if (member.rank <= 3) row.classList.add('board__row--top');

      const rank = document.createElement('div');
      rank.className = 'board__rank';
      rank.textContent = member.rank <= 3 ? medals[member.rank - 1] : member.rank;

      const avatar = document.createElement('div');
      avatar.className = 'board__avatar';
      avatar.textContent = member.avatar;

      const who = document.createElement('div');
      who.className = 'board__who';
      const name = document.createElement('div');
      name.className = 'board__name';
      name.textContent = member.isMe ? `${member.name} (you)` : member.name;
      const meta = document.createElement('div');
      meta.className = 'board__meta';
      meta.textContent = describeMember(member);
      who.append(name, meta);

      const total = document.createElement('div');
      total.className = 'board__total';
      total.innerHTML = `<b class="num">${fmt(member.total)}</b><span>${
        member.goalPercent
      }% of goal</span>`;

      const cheer = document.createElement('button');
      cheer.className = 'cheerbtn';
      if (member.cheeredByMe) cheer.classList.add('cheerbtn--on');
      cheer.textContent = `👏 ${member.cheersReceived || ''}`.trim();
      cheer.disabled = member.isMe;
      cheer.title = member.isMe
        ? 'You cannot cheer yourself'
        : member.cheeredByMe
          ? `Undo your cheer for ${member.name}`
          : `Cheer ${member.name} on`;
      cheer.addEventListener('click', () => toggleCheer(member));

      row.append(rank, avatar, who, total, cheer);
      return row;
    })
  );

  const { loggedToday, memberCount } = week.group;
  const pill = el('loggedToday');
  if (week.isCurrentWeek) {
    pill.textContent = `${loggedToday}/${memberCount} logged today`;
    pill.className = `pill ${loggedToday === memberCount ? 'pill--good' : 'pill--warn'}`;
  } else {
    pill.textContent = 'Finished week';
    pill.className = 'pill';
  }
}

function describeMember(member) {
  const parts = [`${member.loggedDays}/7 days logged`];
  if (member.isGhost) {
    parts.push(member.lastLoggedDay ? `last logged ${member.lastLoggedDay}` : 'nothing yet');
  }
  parts.push(member.paceDelta >= 0 ? 'on pace' : `${fmt(-member.paceDelta)} behind pace`);
  return parts.join(' · ');
}

async function toggleCheer(member) {
  try {
    if (member.cheeredByMe) await api.uncheer(member.id, week.weekStart);
    else await api.cheer(member.id, week.weekStart);
    await load();
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------- group goal

function renderGroup() {
  const { journeyName, percent, total, goal } = week.group;
  const remaining = Math.max(0, goal - total);

  el('groupCard').innerHTML = `
    <div class="card__head">
      <h2>Group goal</h2>
      <button class="btn btn--ghost btn--sm" id="groupEdit">Change</button>
    </div>
    <div class="goal__head">
      <div class="goal__title">Walking to ${escapeHtml(journeyName)}</div>
      <div class="goal__pct num">${percent}%</div>
    </div>
    <div class="goalbar"><div class="goalbar__fill" style="width: ${percent}%"></div></div>
    <div class="goal__row">
      <span><b class="num">${fmt(total)}</b> of ${fmt(goal)} steps together</span>
      <span>${
        remaining > 0 ? `<b class="num">${fmt(remaining)}</b> to go` : '🎉 You made it!'
      }</span>
    </div>
    <p class="hint">
      Everyone's steps count towards this, wherever you are on the leaderboard.
    </p>
  `;

  el('groupEdit').addEventListener('click', openGroupDialog);
}

// ------------------------------------------------------------------ dialogs

function openProfileDialog() {
  const me = week.members.find((m) => m.isMe);
  if (!me) return;

  el('profileError').hidden = true;
  el('profileName').value = me.name;
  el('profileGoal').value = me.weeklyGoal;

  let chosen = me.avatar;
  el('profileAvatars').replaceChildren(
    ...avatars.map((emoji) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = emoji;
      button.setAttribute('aria-pressed', String(emoji === chosen));
      button.addEventListener('click', () => {
        chosen = emoji;
        for (const other of el('profileAvatars').children) {
          other.setAttribute('aria-pressed', String(other === button));
        }
      });
      return button;
    })
  );

  el('profileSave').onclick = async () => {
    el('profileError').hidden = true;
    try {
      await api.updateMe({
        name: el('profileName').value,
        avatar: chosen,
        weeklyGoal: Number(el('profileGoal').value),
      });
      el('profileDialog').close();
      await load();
    } catch (err) {
      el('profileError').textContent = err.message;
      el('profileError').hidden = false;
    }
  };

  // Never leave a typed password sitting in the DOM from a previous open.
  el('currentPassword').value = '';
  el('newPassword').value = '';

  el('passwordSave').onclick = async () => {
    el('profileError').hidden = true;
    el('passwordSave').disabled = true;
    try {
      // The server replaces the session cookie as part of this, so we stay
      // signed in here while every other device is dropped.
      await api.changePassword(el('currentPassword').value, el('newPassword').value);
      el('currentPassword').value = '';
      el('newPassword').value = '';
      el('profileDialog').close();
      toast('Password updated. Other devices have been signed out.');
    } catch (err) {
      el('profileError').textContent = err.message;
      el('profileError').hidden = false;
    } finally {
      el('passwordSave').disabled = false;
    }
  };

  el('profileDialog').showModal();
}

function openGroupDialog() {
  el('groupError').hidden = true;
  el('groupNameInput').value = week.group.name;
  el('journeyName').value = week.group.journeyName;
  el('journeyGoal').value = week.group.goal;

  el('groupSave').onclick = async () => {
    el('groupError').hidden = true;
    try {
      await api.updateGroup({
        groupName: el('groupNameInput').value,
        journeyName: el('journeyName').value,
        journeyGoalSteps: Number(el('journeyGoal').value),
      });
      el('groupDialog').close();
      await load();
    } catch (err) {
      el('groupError').textContent = err.message;
      el('groupError').hidden = false;
    }
  };

  el('groupDialog').showModal();
}

// -------------------------------------------------------------------- wiring

el('profileBtn').addEventListener('click', openProfileDialog);
el('profileClose').addEventListener('click', () => el('profileDialog').close());
el('groupClose').addEventListener('click', () => el('groupDialog').close());
el('groupCancel').addEventListener('click', () => el('groupDialog').close());
el('jumpToMe').addEventListener('click', () => track.scrollToMe());

el('logoutBtn').addEventListener('click', async () => {
  await api.logout();
  location.href = '/login';
});

el('weekPrev').addEventListener('click', () => load(shiftWeek(-1)));
el('weekNext').addEventListener('click', () => load(shiftWeek(1)));
el('weekThis').addEventListener('click', () => load(null));

function shiftWeek(delta) {
  const date = new Date(`${week.weekStart}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta * 7);
  return date.toISOString().slice(0, 10);
}

// Left/right arrows nudge the track, so a keyboard works as well as a swipe.
window.addEventListener('keydown', (event) => {
  if (event.target.tagName === 'INPUT' || document.querySelector('dialog[open]')) return;
  if (event.key === 'ArrowLeft') el('trackScroll').scrollBy({ left: -260, behavior: 'smooth' });
  if (event.key === 'ArrowRight') el('trackScroll').scrollBy({ left: 260, behavior: 'smooth' });
});

// ------------------------------------------------------------------- helpers

/**
 * Brief message at the bottom of the screen.
 * Deliberately not alert() -- a native dialog blocks the whole page, which is
 * a heavy penalty for "you already cheered them this week".
 */
let toastTimer = null;
function toast(message) {
  const box = el('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, 3200);
}

function ordinal(n) {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return `${n}${suffix}`;
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );
}

// ---------------------------------------------------------------------- boot

try {
  avatars = (await api.config()).avatars;
} catch {
  avatars = [];
}
await load();

// Someone else logging steps should show up without a manual refresh.
setInterval(() => {
  if (!document.hidden && !document.querySelector('dialog[open]')) load();
}, 30000);
