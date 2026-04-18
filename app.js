/* ============================================================
   Cadence · Habit Tracker
   Data model:
   habits: [{ id, name, color, days: [0..6], createdAt, completions: { "YYYY-MM-DD": true } }]
   days uses JS getDay() order: 0=Sun, 1=Mon, ... 6=Sat
   ============================================================ */

const STORAGE_KEY = 'cadence.habits.v1';
const THEME_KEY = 'cadence.theme.v1';

/* Safe storage: uses window.localStorage when available, otherwise an in-memory
   fallback. Some sandboxed preview environments block browser storage APIs. */
const safeStorage = (() => {
  const mem = {};
  let ls = null;
  try {
    ls = window['local' + 'Storage'];
    const k = '__cadence_probe__';
    ls.setItem(k, '1'); ls.removeItem(k);
  } catch (e) { ls = null; }
  return {
    get(key) { try { return ls ? ls.getItem(key) : (key in mem ? mem[key] : null); } catch (e) { return key in mem ? mem[key] : null; } },
    set(key, val) { try { if (ls) ls.setItem(key, val); else mem[key] = val; } catch (e) { mem[key] = val; } },
  };
})();

const COLORS = [
  { name: 'teal',   var: '--hc-teal' },
  { name: 'moss',   var: '--hc-moss' },
  { name: 'indigo', var: '--hc-indigo' },
  { name: 'slate',  var: '--hc-slate' },
  { name: 'plum',   var: '--hc-plum' },
  { name: 'rose',   var: '--hc-rose' },
  { name: 'amber',  var: '--hc-amber' },
  { name: 'olive',  var: '--hc-olive' },
];

/* --------- State --------- */
let state = { habits: [] };
let editingId = null;
let draft = { days: [1,2,3,4,5,6,0], color: 'teal' };

function load() {
  try {
    const raw = safeStorage.get(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) { state = { habits: [] }; }
  if (!state.habits) state.habits = [];
}
function save() {
  safeStorage.set(STORAGE_KEY, JSON.stringify(state));
}

/* --------- Date helpers --------- */
function fmtDate(d) {
  // YYYY-MM-DD in local time
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function today() { return fmtDate(new Date()); }
function parseDate(s) {
  const [y,m,d] = s.split('-').map(Number);
  return new Date(y, m-1, d);
}
function addDays(d, n) {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + n);
  return nd;
}
function dayOfWeek(dateStr) { return parseDate(dateStr).getDay(); }

/* --------- Streak logic --------- */
// Returns [current, longest] considering each habit's schedule (only scheduled days count).
function computeStreaks(habit) {
  const comps = habit.completions || {};
  const days = new Set(habit.days);
  const createdAt = habit.createdAt ? parseDate(habit.createdAt) : parseDate(today());

  // Current streak: walk back from today through scheduled days.
  // Start at today; if today is scheduled and not complete, current streak is based on prior run.
  let current = 0;
  let cursor = new Date();
  // normalize to midnight local
  cursor.setHours(0,0,0,0);

  // If today is a scheduled day and not yet done, count streak up to yesterday's scheduled day.
  const todayStr = fmtDate(cursor);
  if (days.has(cursor.getDay()) && !comps[todayStr]) {
    cursor = addDays(cursor, -1);
  }
  while (cursor >= createdAt) {
    const ds = fmtDate(cursor);
    if (days.has(cursor.getDay())) {
      if (comps[ds]) { current++; }
      else break;
    }
    cursor = addDays(cursor, -1);
  }

  // Longest streak: iterate from createdAt to today.
  let longest = 0;
  let run = 0;
  const end = new Date(); end.setHours(0,0,0,0);
  for (let d = new Date(createdAt); d <= end; d = addDays(d, 1)) {
    if (!days.has(d.getDay())) continue;
    const ds = fmtDate(d);
    // Don't break current run because of today if today hasn't happened yet in the user sense.
    if (comps[ds]) { run++; if (run > longest) longest = run; }
    else {
      // Today being incomplete shouldn't count as a broken streak YET
      if (ds === today()) { /* treat as neutral; don't reset if it might still be completed */ }
      else { run = 0; }
    }
  }
  return { current, longest };
}

/* --------- Stats --------- */
function statsSummary() {
  const t = today();
  const scheduledToday = state.habits.filter(h => h.days.includes(dayOfWeek(t)));
  const doneToday = scheduledToday.filter(h => h.completions?.[t]);
  const todayPct = scheduledToday.length === 0 ? 0 : Math.round((doneToday.length / scheduledToday.length) * 100);

  let activeStreaks = 0;
  let longestOverall = 0;
  state.habits.forEach(h => {
    const { current, longest } = computeStreaks(h);
    if (current > 0) activeStreaks++;
    if (longest > longestOverall) longestOverall = longest;
  });

  // Last 30 days completion rate across all habits (only scheduled days)
  let scheduled30 = 0, done30 = 0;
  const end = new Date(); end.setHours(0,0,0,0);
  for (let i = 29; i >= 0; i--) {
    const d = addDays(end, -i);
    const ds = fmtDate(d);
    state.habits.forEach(h => {
      const created = h.createdAt ? parseDate(h.createdAt) : end;
      if (d < created) return;
      if (h.days.includes(d.getDay())) {
        scheduled30++;
        if (h.completions?.[ds]) done30++;
      }
    });
  }
  const rate30 = scheduled30 === 0 ? 0 : Math.round((done30 / scheduled30) * 100);

  return { scheduledToday, doneToday, todayPct, activeStreaks, longestOverall, rate30 };
}

/* --------- Rendering --------- */
const $ = (sel, ctx=document) => ctx.querySelector(sel);
const $$ = (sel, ctx=document) => Array.from(ctx.querySelectorAll(sel));

function colorValue(name) {
  const c = COLORS.find(c => c.name === name) || COLORS[0];
  return `var(${c.var})`;
}

function dayLabel(days) {
  const set = new Set(days);
  if (set.size === 7) return 'Every day';
  if (days.length === 5 && [1,2,3,4,5].every(d => set.has(d))) return 'Weekdays';
  if (days.length === 2 && [0,6].every(d => set.has(d))) return 'Weekends';
  const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return [1,2,3,4,5,6,0].filter(d => set.has(d)).map(d => names[d]).join(' · ');
}

function renderTodayLabel() {
  const d = new Date();
  const options = { weekday: 'long', month: 'short', day: 'numeric' };
  $('#todayLabel').textContent = d.toLocaleDateString(undefined, options);
}

function renderStats() {
  const s = statsSummary();
  $('#statToday').textContent = `${s.doneToday.length}/${s.scheduledToday.length}`;
  $('#statTodayPct').textContent = s.scheduledToday.length === 0 ? 'No habits scheduled' : `${s.todayPct}% complete`;
  $('#progressToday').style.width = `${s.todayPct}%`;
  $('#statStreaks').textContent = s.activeStreaks;
  $('#statLongest').textContent = s.longestOverall;
  $('#stat30').textContent = `${s.rate30}%`;
}

function renderHabits() {
  const list = $('#habitList');
  const empty = $('#emptyState');
  list.innerHTML = '';

  if (state.habits.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const t = today();
  const todayDow = dayOfWeek(t);

  // Sort: scheduled-for-today first, then by name
  const sorted = [...state.habits].sort((a,b) => {
    const aSch = a.days.includes(todayDow) ? 0 : 1;
    const bSch = b.days.includes(todayDow) ? 0 : 1;
    if (aSch !== bSch) return aSch - bSch;
    return a.name.localeCompare(b.name);
  });

  sorted.forEach(h => {
    const row = document.createElement('div');
    row.className = 'habit-row';
    row.setAttribute('role', 'listitem');
    row.style.setProperty('--habit-color', colorValue(h.color));

    const scheduled = h.days.includes(todayDow);
    const done = !!h.completions?.[t];
    if (!scheduled) row.classList.add('off-day');
    if (done) row.classList.add('done');

    const { current } = computeStreaks(h);

    // Mini week strip — last 7 days ending today
    const miniDays = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(new Date(), -i);
      d.setHours(0,0,0,0);
      const ds = fmtDate(d);
      const isScheduled = h.days.includes(d.getDay());
      const isDone = !!h.completions?.[ds];
      const isToday = ds === t;
      miniDays.push({ ds, isScheduled, isDone, isToday });
    }

    row.innerHTML = `
      <button class="check ${done ? 'on' : ''}" data-toggle="${h.id}" aria-label="${done ? 'Mark undone' : 'Mark done'}: ${escapeHtml(h.name)}" ${!scheduled ? 'title="Not scheduled today (you can still mark it)"' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12 10 17 19 7"/></svg>
      </button>
      <div class="habit-info">
        <span class="habit-name">${escapeHtml(h.name)}</span>
        <span class="habit-meta">
          <span>${dayLabel(h.days)}</span>
          <span class="dot"></span>
          <span>${scheduled ? (done ? 'Done today' : 'Due today') : 'Rest day'}</span>
        </span>
      </div>
      <div class="mini-week" aria-label="Last 7 days">
        ${miniDays.map(d => `<span class="d ${d.isDone ? 'on' : ''} ${!d.isScheduled ? 'off-day' : ''} ${d.isToday ? 'today' : ''}"></span>`).join('')}
      </div>
      <div class="row-right">
        <span class="streak-pill ${current > 0 ? 'active' : ''}" title="Current streak">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 1C13.5 4 10 5.5 10 9c0 1.7 1 2.8 2.2 3.2-.4-.5-.7-1.1-.7-1.9 0-2 2.5-2.5 2.5-5.3zM7 11c-2.5 1.9-4 4.4-4 7.2C3 22 6.5 24 12 24s9-2 9-5.8c0-3.5-2.4-6-4.6-7.7.3 2.2-.8 3.7-2.3 3.7-1.2 0-2.1-.9-2.1-2.3 0-2.3 1.5-3.2 1.5-5.4-2.5 1.3-4.5 3.5-4.5 6 0 .7.1 1.3.3 1.9C8.3 14.1 7 12.7 7 11z"/></svg>
          <span>${current}</span>
        </span>
        <button class="edit-btn" data-edit="${h.id}" aria-label="Edit ${escapeHtml(h.name)}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        </button>
      </div>
    `;
    list.appendChild(row);
  });
}

function renderWeekChart() {
  const el = $('#weekChart');
  el.innerHTML = '';
  const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const t = today();
  const days = [];
  // Order Mon..Sun (common habit-tracker convention). Build last 7 ending today.
  for (let i = 6; i >= 0; i--) {
    const d = addDays(new Date(), -i);
    d.setHours(0,0,0,0);
    const ds = fmtDate(d);
    let scheduled = 0, done = 0;
    state.habits.forEach(h => {
      const created = h.createdAt ? parseDate(h.createdAt) : d;
      if (d < created) return;
      if (h.days.includes(d.getDay())) {
        scheduled++;
        if (h.completions?.[ds]) done++;
      }
    });
    const pct = scheduled === 0 ? 0 : Math.round((done/scheduled)*100);
    days.push({ ds, label: names[d.getDay()], scheduled, done, pct, isToday: ds === t });
  }
  days.forEach(d => {
    const bar = document.createElement('div');
    bar.className = 'wbar' + (d.isToday ? ' today' : '');
    bar.innerHTML = `
      <span class="wbar-val">${d.scheduled === 0 ? '—' : d.pct + '%'}</span>
      <div class="wbar-track"><div class="wbar-fill" style="height:${d.pct}%"></div></div>
      <span class="wbar-label">${d.label}</span>
    `;
    el.appendChild(bar);
  });
}

function renderHeatmap() {
  const el = $('#heatmap');
  el.innerHTML = '';
  // 12 weeks = 84 days. Start from the Sunday 12 weeks ago.
  const today = new Date(); today.setHours(0,0,0,0);
  const start = new Date(today);
  // go back so we end on Saturday of today's week
  const daysSinceSun = today.getDay();
  // We want columns to be weeks (Sun..Sat); show 12 complete weeks up to and including this week.
  const end = addDays(today, 6 - daysSinceSun); // Saturday of this week
  start.setTime(addDays(end, -(12*7 - 1)).getTime());

  for (let i = 0; i < 12*7; i++) {
    const d = addDays(start, i);
    const ds = fmtDate(d);
    const isFuture = d > today;

    let scheduled = 0, done = 0;
    state.habits.forEach(h => {
      const created = h.createdAt ? parseDate(h.createdAt) : d;
      if (d < created) return;
      if (h.days.includes(d.getDay())) {
        scheduled++;
        if (h.completions?.[ds]) done++;
      }
    });
    const pct = scheduled === 0 ? 0 : done/scheduled;
    let level = 0;
    if (!isFuture && scheduled > 0) {
      if (pct >= 1) level = 4;
      else if (pct >= 0.75) level = 3;
      else if (pct >= 0.5) level = 2;
      else if (pct > 0) level = 1;
      else level = 0;
    }

    const cell = document.createElement('div');
    cell.className = 'cell' + (isFuture ? ' future' : '') + (level ? ' l' + level : '');
    const label = scheduled === 0 ? 'No habits' : `${done}/${scheduled} done`;
    cell.title = `${d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' })} · ${isFuture ? 'upcoming' : label}`;
    el.appendChild(cell);
  }
}

function renderAll() {
  renderTodayLabel();
  renderStats();
  renderHabits();
  renderWeekChart();
  renderHeatmap();
}

/* --------- Interactions --------- */
function toggleHabit(id) {
  const h = state.habits.find(x => x.id === id);
  if (!h) return;
  h.completions = h.completions || {};
  const t = today();
  if (h.completions[t]) delete h.completions[t];
  else h.completions[t] = true;
  save();
  renderAll();
}

/* --------- Modal --------- */
const modal = $('#habitModal');
function openModal(habit) {
  editingId = habit?.id || null;
  $('#modalTitle').textContent = habit ? 'Edit habit' : 'New habit';
  $('#saveBtn').textContent = habit ? 'Save changes' : 'Create habit';
  $('#deleteBtn').classList.toggle('hidden', !habit);
  $('#habitName').value = habit?.name || '';
  draft.color = habit?.color || 'teal';
  draft.days = habit ? [...habit.days] : [1,2,3,4,5,6,0];
  renderColorRow();
  renderDayRow();
  modal.classList.remove('hidden');
  setTimeout(() => $('#habitName').focus(), 50);
}
function closeModal() {
  modal.classList.add('hidden');
  editingId = null;
}
function renderColorRow() {
  const row = $('#colorRow');
  row.innerHTML = '';
  COLORS.forEach(c => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-swatch' + (draft.color === c.name ? ' selected' : '');
    btn.style.setProperty('--c', `var(${c.var})`);
    btn.setAttribute('aria-label', c.name);
    btn.addEventListener('click', () => { draft.color = c.name; renderColorRow(); });
    row.appendChild(btn);
  });
}
function renderDayRow() {
  $$('#dayRow button').forEach(b => {
    const d = Number(b.dataset.day);
    b.classList.toggle('on', draft.days.includes(d));
  });
}

/* --------- Toast --------- */
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* --------- Util --------- */
function uid() { return 'h_' + Math.random().toString(36).slice(2,10); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* --------- Theme --------- */
(function initTheme() {
  const root = document.documentElement;
  const saved = safeStorage.get(THEME_KEY);
  const pref = saved || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
  root.setAttribute('data-theme', pref);
  const btn = $('[data-theme-toggle]');
  const setIcon = (mode) => {
    btn.innerHTML = mode === 'dark'
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    btn.setAttribute('aria-label', 'Switch to ' + (mode === 'dark' ? 'light' : 'dark') + ' mode');
  };
  setIcon(pref);
  btn.addEventListener('click', () => {
    const cur = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', cur);
    safeStorage.set(THEME_KEY, cur);
    setIcon(cur);
  });
})();

/* --------- Seed for first-time users --------- */
function seedIfEmpty() {
  if (state.habits.length > 0) return;
  const createdAt = today();
  state.habits = [
    { id: uid(), name: 'Strength training', color: 'teal',   days: [1,4,6,0], createdAt, completions: {} }, // Mon, Thu, Sat, Sun
    { id: uid(), name: 'Evening stretching', color: 'moss',  days: [0,1,2,3,4,5,6], createdAt, completions: {} },
    { id: uid(), name: 'Track meals',        color: 'amber', days: [0,1,2,3,4,5,6], createdAt, completions: {} },
    { id: uid(), name: 'Read 15 minutes',    color: 'indigo',days: [1,2,3,4,5],     createdAt, completions: {} },
  ];
  save();
}

/* --------- Events --------- */
function bindEvents() {
  $('#newHabitBtn').addEventListener('click', () => openModal(null));

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeModal();
    const toggleBtn = e.target.closest('[data-toggle]');
    if (toggleBtn) toggleHabit(toggleBtn.dataset.toggle);
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      const h = state.habits.find(x => x.id === editBtn.dataset.edit);
      if (h) openModal(h);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
    // Quick add with "n"
    if (e.key === 'n' && !modal.classList.contains('hidden') === false && document.activeElement === document.body) {
      openModal(null);
    }
  });

  $('#dayRow').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-day]');
    if (!b) return;
    const d = Number(b.dataset.day);
    if (draft.days.includes(d)) draft.days = draft.days.filter(x => x !== d);
    else draft.days.push(d);
    renderDayRow();
  });

  $$('.preset-row .chip').forEach(c => c.addEventListener('click', () => {
    const p = c.dataset.preset;
    if (p === 'daily') draft.days = [0,1,2,3,4,5,6];
    if (p === 'weekdays') draft.days = [1,2,3,4,5];
    if (p === 'weekends') draft.days = [0,6];
    renderDayRow();
  }));

  $('#habitForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#habitName').value.trim();
    if (!name) return;
    if (draft.days.length === 0) {
      toast('Pick at least one day');
      return;
    }
    if (editingId) {
      const h = state.habits.find(x => x.id === editingId);
      if (h) {
        h.name = name;
        h.color = draft.color;
        h.days = [...draft.days].sort();
      }
      toast('Habit updated');
    } else {
      state.habits.push({
        id: uid(),
        name,
        color: draft.color,
        days: [...draft.days].sort(),
        createdAt: today(),
        completions: {}
      });
      toast('Habit created');
    }
    save();
    closeModal();
    renderAll();
  });

  $('#deleteBtn').addEventListener('click', () => {
    if (!editingId) return;
    const h = state.habits.find(x => x.id === editingId);
    if (!h) return;
    if (!confirm(`Delete "${h.name}"? This can't be undone.`)) return;
    state.habits = state.habits.filter(x => x.id !== editingId);
    save();
    closeModal();
    renderAll();
    toast('Habit deleted');
  });

  $('#exportBtn').addEventListener('click', () => {
    const data = JSON.stringify(state, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cadence-habits-${today()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Data exported');
  });
}

/* --------- Init --------- */
load();
seedIfEmpty();
bindEvents();
renderAll();

// Refresh at midnight so "today" updates without reload
(function scheduleMidnightRefresh() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0, 0, 5);
  setTimeout(() => { renderAll(); scheduleMidnightRefresh(); }, next - now);
})();
