/* ==========================================================
   Cadence · Habitify-style habit tracker
   Data model (v2):
   state = {
     areas: [{id, name, color}],
     habits: [{
       id, name, icon, color, areaId, tod,  // 'any'|'morning'|'afternoon'|'evening'
       days: [0..6], goalType: 'simple'|'count', target, unit,
       createdAt, priority
     }],
     logs: { habitId: { "YYYY-MM-DD": { status: 'done'|'skip'|'fail'|'none', count, note, timestamp } } },
     moods: { "YYYY-MM-DD": { value: 1..5, note, timestamp } },
     sessions: [{id, habitId, seconds, completedAt}],
     settings: { timeRanges: { morning: [6,12], afternoon: [12,17], evening: [17,22] } }
   }
   ========================================================== */

const STORAGE_KEY = 'cadence.app.v2';
const THEME_KEY   = 'cadence.theme.v1';

/* ---------- Safe storage (works in sandboxed iframe) ---------- */
const safeStorage = (() => {
  const mem = {};
  let ls = null;
  try {
    ls = window['local' + 'Storage'];
    const k = '__cadence_probe__';
    ls.setItem(k, '1'); ls.removeItem(k);
  } catch (e) { ls = null; }
  return {
    get(key)   { try { return ls ? ls.getItem(key) : (key in mem ? mem[key] : null); } catch (e) { return key in mem ? mem[key] : null; } },
    set(key,v) { try { if (ls) ls.setItem(key, v); else mem[key] = v; } catch (e) { mem[key] = v; } },
  };
})();

/* ---------- Palettes ---------- */
const COLORS = [
  { name: 'teal',   var: '--hc-teal' },
  { name: 'moss',   var: '--hc-moss' },
  { name: 'sky',    var: '--hc-sky' },
  { name: 'indigo', var: '--hc-indigo' },
  { name: 'slate',  var: '--hc-slate' },
  { name: 'plum',   var: '--hc-plum' },
  { name: 'rose',   var: '--hc-rose' },
  { name: 'coral',  var: '--hc-coral' },
  { name: 'amber',  var: '--hc-amber' },
  { name: 'olive',  var: '--hc-olive' },
];
const ICONS = ['🏋️','🏃','🧘','💧','📖','🥗','😴','🪥','💊','🧠','✍️','🎯','🌱','🚴','⛰️','🧺','☀️','🍎','☕','🎵','💬','🧹','💻','🌿'];

const TEMPLATES = [
  { name: 'Drink water',       icon: '💧', goalType: 'count', target: 8,  unit: 'glasses', tod: 'any' },
  { name: 'Meditate',          icon: '🧘', goalType: 'simple', tod: 'morning' },
  { name: 'Read',              icon: '📖', goalType: 'count', target: 15, unit: 'min', tod: 'evening' },
  { name: 'Strength training', icon: '🏋️', goalType: 'simple', tod: 'morning' },
  { name: 'Run',               icon: '🏃', goalType: 'simple', tod: 'morning' },
  { name: 'Stretch',           icon: '🌿', goalType: 'simple', tod: 'evening' },
  { name: 'Track meals',       icon: '🥗', goalType: 'simple', tod: 'any' },
  { name: 'Sleep 8 hours',     icon: '😴', goalType: 'simple', tod: 'evening' },
  { name: 'Journal',           icon: '✍️', goalType: 'simple', tod: 'evening' },
  { name: 'No screens 1h before bed', icon: '🌙', goalType: 'simple', tod: 'evening' },
  { name: 'Take vitamins',     icon: '💊', goalType: 'simple', tod: 'morning' },
  { name: 'Walk 10k steps',    icon: '🚶', goalType: 'count', target: 10000, unit: 'steps', tod: 'any' },
];

const MOOD_META = {
  1: { label: 'Terrible',  emoji: '😣' },
  2: { label: 'Bad',       emoji: '😕' },
  3: { label: 'Okay',      emoji: '😐' },
  4: { label: 'Good',      emoji: '🙂' },
  5: { label: 'Excellent', emoji: '😄' },
};

const DEFAULT_TOD = { morning: [5, 12], afternoon: [12, 17], evening: [17, 23] };

/* ---------- State ---------- */
let state = null;
let ui = {
  tab: 'journal',
  selectedDate: todayISO(),
  tod: 'all',
  area: 'all',          // 'all' or areaId
  editingHabit: null,
  editingArea: null,
  draft: {},            // habit draft
  noteFor: null,        // { habitId, date }
  moodDraft: null,      // { value, note }
  range: 7,
  timer: {
    habitId: null,
    durationSec: 25 * 60,
    remainingSec: 25 * 60,
    running: false,
    intervalId: null,
    startedAt: null,
  },
};

/* ---------- Persistence ---------- */
function load() {
  try {
    const raw = safeStorage.get(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) { state = null; }
  if (!state) state = {};
  state.areas = state.areas || [];
  state.habits = state.habits || [];
  state.logs = state.logs || {};
  state.moods = state.moods || {};
  state.sessions = state.sessions || [];
  state.settings = state.settings || { timeRanges: DEFAULT_TOD };
}
function save() {
  safeStorage.set(STORAGE_KEY, JSON.stringify(state));
  // Mirror to cloud when signed in
  if (window.cadenceSync && window.cadenceSync.user) {
    setSyncState('saving');
    window.cadenceSync.pushRemote(state);
  }
}

/* ---------- Sync status badge ---------- */
let _syncIdleTimer = null;
function setSyncState(s) {
  const el = document.getElementById('syncBadge');
  if (!el) return;
  const label = el.querySelector('.sync-label');
  el.classList.remove('hidden');
  el.dataset.state = s;
  const map = { synced: 'Synced', saving: 'Saving…', error: 'Sync error', offline: 'Local only', signedout: 'Sign in to sync' };
  if (label) label.textContent = map[s] || s;
  clearTimeout(_syncIdleTimer);
  if (s === 'saving') {
    _syncIdleTimer = setTimeout(() => setSyncState('synced'), 1500);
  }
}
window.addEventListener('cadence-sync-saved', () => setSyncState('synced'));
window.addEventListener('cadence-sync-error', () => setSyncState('error'));

/* ---------- Date helpers ---------- */
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function todayISO() { return fmtDate(new Date()); }
function parseDate(s) {
  const [y,m,d] = s.split('-').map(Number);
  return new Date(y, m-1, d);
}
function addDays(d, n) { const nd = new Date(d); nd.setDate(nd.getDate()+n); return nd; }
function dayOfWeek(dateStr) { return parseDate(dateStr).getDay(); }

/* ---------- Utils ---------- */
const $  = (s, c=document) => c.querySelector(s);
const $$ = (s, c=document) => Array.from(c.querySelectorAll(s));
function uid(pfx='id') { return pfx + '_' + Math.random().toString(36).slice(2,10); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function colorValue(name) { const c = COLORS.find(c => c.name === name) || COLORS[0]; return `var(${c.var})`; }

/* ---------- Time of day ---------- */
function currentTOD() {
  const h = new Date().getHours();
  const r = state.settings.timeRanges;
  if (h >= r.morning[0]   && h < r.morning[1])   return 'morning';
  if (h >= r.afternoon[0] && h < r.afternoon[1]) return 'afternoon';
  if (h >= r.evening[0]   && h < r.evening[1])   return 'evening';
  return 'morning';
}

/* ---------- Log accessors ---------- */
function getLog(habitId, dateStr) {
  return state.logs[habitId]?.[dateStr] || null;
}
function setLog(habitId, dateStr, patch) {
  state.logs[habitId] = state.logs[habitId] || {};
  const cur = state.logs[habitId][dateStr] || { status: 'none', count: 0, note: '', timestamp: Date.now() };
  const next = { ...cur, ...patch, timestamp: Date.now() };
  if (next.status === 'none' && !next.count && !next.note) {
    delete state.logs[habitId][dateStr];
  } else {
    state.logs[habitId][dateStr] = next;
  }
  save();
}

/* ---------- Habit helpers ---------- */
function habitById(id) { return state.habits.find(h => h.id === id); }
function areaById(id)  { return state.areas.find(a => a.id === id); }

function isDoneLog(habit, log) {
  if (!log) return false;
  if (log.status === 'done') return true;
  if (habit.goalType === 'count' && (log.count || 0) >= habit.target) return true;
  return false;
}
function habitScheduled(habit, dateStr) { return habit.days.includes(dayOfWeek(dateStr)); }
function habitMatchesTOD(habit, tod) {
  if (tod === 'all') return true;
  return habit.tod === tod || habit.tod === 'any';
}
function habitMatchesArea(habit, area) {
  if (area === 'all') return true;
  if (area === 'none') return !habit.areaId;
  return habit.areaId === area;
}

/* Streak computation: Skip does NOT break streak; Fail and "none" (for a past scheduled day) DO. */
function computeStreaks(habit) {
  const logs = state.logs[habit.id] || {};
  const days = new Set(habit.days);
  const createdAt = habit.createdAt ? parseDate(habit.createdAt) : parseDate(todayISO());
  const today = new Date(); today.setHours(0,0,0,0);

  // Current streak: walk back from today across scheduled days (skip days neither add nor break).
  let current = 0;
  let cursor = new Date(today);
  const todayStr = fmtDate(cursor);
  // If today is scheduled but not yet done, start streak count from yesterday.
  const todayLog = logs[todayStr];
  if (days.has(cursor.getDay()) && !isDoneLog(habit, todayLog) && todayLog?.status !== 'skip') {
    cursor = addDays(cursor, -1);
  }
  while (cursor >= createdAt) {
    if (days.has(cursor.getDay())) {
      const ds = fmtDate(cursor);
      const log = logs[ds];
      if (isDoneLog(habit, log)) current++;
      else if (log?.status === 'skip') { /* neutral */ }
      else break;
    }
    cursor = addDays(cursor, -1);
  }

  // Longest
  let longest = 0, run = 0;
  for (let d = new Date(createdAt); d <= today; d = addDays(d, 1)) {
    if (!days.has(d.getDay())) continue;
    const ds = fmtDate(d);
    const log = logs[ds];
    if (isDoneLog(habit, log)) { run++; if (run > longest) longest = run; }
    else if (log?.status === 'skip') { /* neutral */ }
    else { if (ds !== todayISO()) run = 0; }
  }
  return { current, longest };
}

/* Completion rate over last N days (only scheduled days count). */
function habitCompletionRate(habit, days) {
  const logs = state.logs[habit.id] || {};
  const end = new Date(); end.setHours(0,0,0,0);
  const start = addDays(end, -(days - 1));
  const createdAt = habit.createdAt ? parseDate(habit.createdAt) : end;
  let scheduled = 0, done = 0;
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    if (d < createdAt) continue;
    if (!habit.days.includes(d.getDay())) continue;
    scheduled++;
    const log = logs[fmtDate(d)];
    if (isDoneLog(habit, log)) done++;
  }
  return { scheduled, done, rate: scheduled === 0 ? 0 : done / scheduled };
}

function dayCompletion(dateStr) {
  // For a given day, across all scheduled habits (non-skipped), return { scheduled, done }.
  let scheduled = 0, done = 0;
  state.habits.forEach(h => {
    const created = h.createdAt ? parseDate(h.createdAt) : parseDate(dateStr);
    if (parseDate(dateStr) < created) return;
    if (!h.days.includes(dayOfWeek(dateStr))) return;
    const log = state.logs[h.id]?.[dateStr];
    if (log?.status === 'skip') return;   // skipped = excluded from denominator
    scheduled++;
    if (isDoneLog(h, log)) done++;
  });
  return { scheduled, done };
}

/* ---------- Seed ---------- */
function seedIfEmpty() {
  if (state.habits.length > 0 || state.areas.length > 0) return;
  const t = todayISO();
  state.areas = [
    { id: uid('a'), name: 'Health',  color: 'moss' },
    { id: uid('a'), name: 'Mind',    color: 'indigo' },
    { id: uid('a'), name: 'Family',  color: 'coral' },
  ];
  const [aHealth, aMind, aFam] = state.areas;
  state.habits = [
    { id: uid('h'), name: 'Strength training', icon: '🏋️', color: 'teal',   areaId: aHealth.id, tod: 'morning', days: [1,4,6,0], goalType: 'simple', createdAt: t, priority: 1 },
    { id: uid('h'), name: 'Drink water',       icon: '💧', color: 'sky',    areaId: aHealth.id, tod: 'any',     days: [0,1,2,3,4,5,6], goalType: 'count', target: 8, unit: 'glasses', createdAt: t, priority: 2 },
    { id: uid('h'), name: 'Evening stretching',icon: '🌿', color: 'moss',   areaId: aHealth.id, tod: 'evening', days: [0,1,2,3,4,5,6], goalType: 'simple', createdAt: t, priority: 3 },
    { id: uid('h'), name: 'Read',              icon: '📖', color: 'indigo', areaId: aMind.id,   tod: 'evening', days: [1,2,3,4,5],     goalType: 'count', target: 15, unit: 'min', createdAt: t, priority: 4 },
    { id: uid('h'), name: 'Meditate',          icon: '🧘', color: 'plum',   areaId: aMind.id,   tod: 'morning', days: [0,1,2,3,4,5,6], goalType: 'simple', createdAt: t, priority: 5 },
    { id: uid('h'), name: 'Family dinner',     icon: '🍎', color: 'coral',  areaId: aFam.id,    tod: 'evening', days: [0,1,2,3,4,5,6], goalType: 'simple', createdAt: t, priority: 6 },
  ];
  save();
}

/* ========================================================== *
 *  RENDERING
 * ========================================================== */

function renderTopLabel() {
  const d = new Date();
  $('#todayLabel').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function renderDateStrip() {
  const el = $('#dateStrip');
  el.innerHTML = '';
  const today = new Date(); today.setHours(0,0,0,0);
  for (let i = -6; i <= 0; i++) {
    const d = addDays(today, i);
    const ds = fmtDate(d);
    const chip = document.createElement('button');
    chip.className = 'date-chip';
    if (ds === todayISO()) chip.classList.add('today');
    if (ds === ui.selectedDate) chip.classList.add('selected');
    const { scheduled, done } = dayCompletion(ds);
    if (scheduled > 0 && done > 0) chip.classList.add('has-data');
    chip.innerHTML = `
      <span class="dow">${d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
      <span class="dom">${d.getDate()}</span>
      <span class="dot"></span>
    `;
    chip.addEventListener('click', () => { ui.selectedDate = ds; renderAll(); });
    el.appendChild(chip);
  }
  // Scroll so today is visible
  setTimeout(() => { el.scrollLeft = el.scrollWidth; }, 0);
}

function renderAreaBar() {
  const el = $('#areaBar');
  el.innerHTML = '';
  const mk = (id, label, color, count) => {
    const chip = document.createElement('button');
    chip.className = 'area-chip' + (ui.area === id ? ' on' : '');
    if (color) chip.style.setProperty('--a-color', colorValue(color));
    chip.innerHTML = `
      ${color ? '<span class="a-dot"></span>' : ''}
      <span>${escapeHtml(label)}</span>
      ${count != null ? `<span class="count">${count}</span>` : ''}
    `;
    chip.addEventListener('click', () => { ui.area = id; renderJournal(); });
    return chip;
  };
  el.appendChild(mk('all', 'All habits', null, state.habits.length));
  state.areas.forEach(a => {
    const count = state.habits.filter(h => h.areaId === a.id).length;
    const chip = mk(a.id, a.name, a.color, count);
    // long press or shift-click to edit
    chip.addEventListener('contextmenu', (e) => { e.preventDefault(); openAreaModal(a); });
    el.appendChild(chip);
  });
  const noAreaCount = state.habits.filter(h => !h.areaId).length;
  if (noAreaCount > 0) el.appendChild(mk('none', 'Unsorted', null, noAreaCount));

  const addBtn = document.createElement('button');
  addBtn.className = 'area-chip area-add';
  addBtn.innerHTML = '+ Area';
  addBtn.addEventListener('click', () => openAreaModal(null));
  el.appendChild(addBtn);
}

function renderTODBar() {
  $$('#todBar .tod-btn').forEach(b => b.classList.toggle('on', b.dataset.tod === ui.tod));
}

function renderDaySummary() {
  const { scheduled, done } = dayCompletion(ui.selectedDate);
  const pct = scheduled === 0 ? 0 : Math.round((done/scheduled)*100);
  const today = new Date(); today.setHours(0,0,0,0);
  const selDate = parseDate(ui.selectedDate);
  const isToday = ui.selectedDate === todayISO();
  const isPast = selDate < today;

  const friendly = isToday ? 'Today' : selDate.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const status = isToday
    ? (scheduled === 0 ? 'Nothing scheduled today' : (pct === 100 ? 'All done — great work' : `${done}/${scheduled} complete · ${pct}%`))
    : (scheduled === 0 ? 'Nothing was scheduled' : `${done}/${scheduled} complete · ${pct}%`);

  // best streak among scheduled habits today
  let activeStreaks = 0, bestStreak = 0;
  state.habits.forEach(h => {
    const { current } = computeStreaks(h);
    if (current > 0) activeStreaks++;
    if (current > bestStreak) bestStreak = current;
  });

  const mood = state.moods[ui.selectedDate];
  const moodDisplay = mood ? MOOD_META[mood.value].emoji : '—';

  $('#daySummary').innerHTML = `
    <div class="ring">
      <svg viewBox="0 0 64 64">
        <circle class="ring-track" cx="32" cy="32" r="28" pathLength="100"/>
        <circle class="ring-fill"  cx="32" cy="32" r="28" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${100 - pct}"/>
      </svg>
      <div class="ring-label">${pct}%</div>
    </div>
    <div class="summary-text">
      <div class="summary-main">${friendly}</div>
      <div class="summary-sub">${status}</div>
    </div>
    <div class="summary-stats">
      <div><b>${activeStreaks}</b>active</div>
      <div><b>${bestStreak}</b>streak</div>
      <div><b>${moodDisplay}</b>mood</div>
    </div>
  `;
}

function renderMoodStrip() {
  const mood = state.moods[ui.selectedDate];
  $$('#moodStrip .mood').forEach(b => b.classList.toggle('on', mood && Number(b.dataset.mood) === mood.value));
  $('#moodCurrent').textContent = mood ? MOOD_META[mood.value].label : 'Not logged';
}

function renderHabits() {
  const list = $('#habitList');
  const empty = $('#emptyState');
  list.innerHTML = '';

  if (state.habits.length === 0) {
    empty.classList.remove('hidden');
    $('#emptyTitle').textContent = 'Start with one habit';
    $('#emptyBody').textContent = 'Tap “New” to add your first habit.';
    return;
  }

  const dateStr = ui.selectedDate;
  const dow = dayOfWeek(dateStr);

  // Filter by area + TOD
  let habits = state.habits
    .filter(h => habitMatchesArea(h, ui.area))
    .filter(h => habitMatchesTOD(h, ui.tod));

  // If viewing today and a TOD is selected, only show scheduled; otherwise still show all filtered.
  const scheduledNow = habits.filter(h => h.days.includes(dow));
  const offDay = habits.filter(h => !h.days.includes(dow));

  if (habits.length === 0) {
    empty.classList.remove('hidden');
    $('#emptyTitle').textContent = 'Nothing here';
    $('#emptyBody').textContent = 'Try a different area or time of day.';
    return;
  }
  empty.classList.add('hidden');

  // Sort: pending > done > skipped/failed
  const sortKey = (h) => {
    const log = getLog(h.id, dateStr);
    const done = isDoneLog(h, log);
    if (done) return 2;
    if (log?.status === 'skip' || log?.status === 'fail') return 3;
    return 1;
  };
  scheduledNow.sort((a,b) => sortKey(a) - sortKey(b) || (a.priority||99) - (b.priority||99));

  // Render scheduled
  scheduledNow.forEach(h => list.appendChild(renderHabitRow(h, dateStr, false)));
  // Render off-day separately, muted
  if (offDay.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'habit-section-title';
    sec.textContent = 'Not scheduled';
    list.appendChild(sec);
    offDay.forEach(h => list.appendChild(renderHabitRow(h, dateStr, true)));
  }
}

function renderHabitRow(h, dateStr, isOff) {
  const row = document.createElement('div');
  row.className = 'habit-row';
  if (isOff) row.classList.add('off-day');
  row.style.setProperty('--habit-color', colorValue(h.color));

  const log = getLog(h.id, dateStr);
  const done = isDoneLog(h, log);
  const status = done ? 'done' : (log?.status || 'none');
  if (status !== 'none') row.classList.add('status-' + status);

  const { current } = computeStreaks(h);

  const area = areaById(h.areaId);
  const areaTag = area
    ? `<span class="area-tag" style="--area-color:${colorValue(area.color)}">${escapeHtml(area.name)}</span>`
    : '';

  const todLabel = h.tod && h.tod !== 'any' ? h.tod.charAt(0).toUpperCase()+h.tod.slice(1) : '';

  // For count goals, show progress bar
  let progressBar = '';
  if (h.goalType === 'count') {
    const pct = Math.min(100, Math.round(((log?.count || 0) / h.target) * 100));
    progressBar = `<div class="habit-progress-bar"><div class="habit-progress-fill" style="width:${pct}%"></div></div>`;
  }

  const statusIcon = {
    done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12 10 17 19 7"/></svg>',
    skip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 4l14 8L5 20z"/></svg>',
    fail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  };

  row.innerHTML = `
    <button class="check status-${status}" data-check="${h.id}" aria-label="${done ? 'Undo' : 'Mark done'}: ${escapeHtml(h.name)}">
      ${status === 'none'
        ? `<span class="icon-emoji">${h.icon || '•'}</span>`
        : (status === 'done'
          ? `<span class="icon-emoji">${h.icon || '✓'}</span>${h.goalType === 'count' ? '' : statusIcon.done.replace('<svg', '<svg class="statusmark"')}`
          : statusIcon[status] || '')}
    </button>
    <div class="habit-info">
      <span class="habit-name">${escapeHtml(h.name)}</span>
      <span class="habit-meta">
        ${areaTag}
        ${areaTag && todLabel ? '<span class="dot"></span>' : ''}
        ${todLabel ? `<span>${todLabel}</span>` : ''}
        ${h.goalType === 'count' ? `<span class="dot"></span><span>${(log?.count || 0)}/${h.target} ${escapeHtml(h.unit || '')}</span>` : ''}
        ${log?.note ? '<span class="dot"></span><span title="Has note">🗒️</span>' : ''}
      </span>
      ${progressBar}
    </div>
    <div class="habit-actions">
      <span class="streak-pill ${current > 0 ? 'active' : ''}" title="Current streak">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 1C13.5 4 10 5.5 10 9c0 1.7 1 2.8 2.2 3.2-.4-.5-.7-1.1-.7-1.9 0-2 2.5-2.5 2.5-5.3zM7 11c-2.5 1.9-4 4.4-4 7.2C3 22 6.5 24 12 24s9-2 9-5.8c0-3.5-2.4-6-4.6-7.7.3 2.2-.8 3.7-2.3 3.7-1.2 0-2.1-.9-2.1-2.3 0-2.3 1.5-3.2 1.5-5.4-2.5 1.3-4.5 3.5-4.5 6 0 .7.1 1.3.3 1.9C8.3 14.1 7 12.7 7 11z"/></svg>
        <span>${current}</span>
      </span>
      <button class="row-menu" data-menu="${h.id}" aria-label="Options for ${escapeHtml(h.name)}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
      </button>
    </div>
  `;
  return row;
}

function renderJournal() {
  renderAreaBar();
  renderTODBar();
  renderDaySummary();
  renderMoodStrip();
  renderHabits();
}

/* ========================================================== *
 *  PROGRESS TAB
 * ========================================================== */

function rangeDates(nDays) {
  const end = new Date(); end.setHours(0,0,0,0);
  const start = addDays(end, -(nDays - 1));
  const dates = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) dates.push(fmtDate(d));
  return dates;
}

function renderProgress() {
  const n = ui.range;
  const dates = rangeDates(n);

  // Habit score
  let tScheduled = 0, tDone = 0;
  dates.forEach(ds => { const c = dayCompletion(ds); tScheduled += c.scheduled; tDone += c.done; });
  const habitScore = tScheduled === 0 ? 0 : Math.round((tDone / tScheduled) * 100);
  $('#habitScore').textContent = habitScore + '%';
  $('#habitScoreSub').textContent = tScheduled === 0 ? 'no scheduled habits' : `${tDone}/${tScheduled}`;
  $('#habitScoreBar').style.width = habitScore + '%';

  // Mood score
  const moodVals = dates.map(ds => state.moods[ds]?.value).filter(Boolean);
  const avgMood = moodVals.length ? (moodVals.reduce((a,b)=>a+b,0)/moodVals.length) : 0;
  $('#moodScore').textContent = avgMood ? avgMood.toFixed(1) + '/5' : '—';
  $('#moodScoreSub').textContent = moodVals.length ? `${moodVals.length} logs` : 'from logs';
  $('#moodScoreBar').style.width = avgMood ? (avgMood/5*100) + '%' : '0%';

  // Active / Stalled
  const now = new Date(); now.setHours(0,0,0,0);
  let active = 0, stalled = 0, bestStreak = 0;
  state.habits.forEach(h => {
    const { current } = computeStreaks(h);
    if (current > bestStreak) bestStreak = current;
    // "active" if done at least once in last 7 days (of scheduled days)
    let foundRecent = false;
    for (let i = 0; i < Math.min(7, n); i++) {
      const ds = fmtDate(addDays(now, -i));
      if (!h.days.includes(parseDate(ds).getDay())) continue;
      if (isDoneLog(h, state.logs[h.id]?.[ds])) { foundRecent = true; break; }
    }
    if (foundRecent) active++; else stalled++;
  });
  $('#activeCount').textContent = active;
  $('#stalledCount').textContent = stalled;
  $('#bestStreak').textContent = bestStreak;

  // Daily completion chart (Perfect / Partial / Missed counts + daily bars)
  const chartEl = $('#completionChart');
  chartEl.innerHTML = '';
  let perf=0, part=0, miss=0;
  dates.forEach(ds => {
    const { scheduled, done } = dayCompletion(ds);
    const isToday = ds === todayISO();
    const col = document.createElement('div');
    col.className = 'c-col' + (isToday ? ' today' : '');
    if (scheduled === 0) {
      col.innerHTML = `<div class="c-seg missed" style="height:4px"></div>`;
    } else {
      const pct = done/scheduled;
      if (pct >= 1) perf++;
      else if (pct > 0) part++;
      else miss++;
      const pH = Math.round(pct * 120);
      const mH = 120 - pH;
      col.innerHTML = `
        ${pct === 1 ? `<div class="c-seg perfect" style="height:120px"></div>`
                    : (pct > 0
                        ? `<div class="c-seg partial" style="height:${pH}px"></div><div class="c-seg missed" style="height:${mH}px"></div>`
                        : `<div class="c-seg missed" style="height:120px"></div>`)}
      `;
    }
    col.title = `${ds}: ${scheduled === 0 ? 'no scheduled habits' : `${done}/${scheduled}`}`;
    chartEl.appendChild(col);
  });
  $('#daysPerfect').textContent = perf;
  $('#daysPartial').textContent = part;
  $('#daysMissed').textContent  = miss;

  // Weekday performance (aggregate across range)
  const wkdEl = $('#weekdayChart');
  wkdEl.innerHTML = '';
  const wkdNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const wkdStats = [0,1,2,3,4,5,6].map(()=>({perfect:0, partial:0, missed:0, total:0}));
  dates.forEach(ds => {
    const { scheduled, done } = dayCompletion(ds);
    if (scheduled === 0) return;
    const dow = dayOfWeek(ds);
    wkdStats[dow].total++;
    const pct = done/scheduled;
    if (pct >= 1) wkdStats[dow].perfect++;
    else if (pct > 0) wkdStats[dow].partial++;
    else wkdStats[dow].missed++;
  });
  // order Mon..Sun for display
  const wkdOrder = [1,2,3,4,5,6,0];
  wkdOrder.forEach(d => {
    const s = wkdStats[d];
    const col = document.createElement('div');
    col.className = 'w-col';
    if (s.total === 0) {
      col.innerHTML = `<div class="w-bar"></div><span class="w-label">${wkdNames[d]}</span>`;
    } else {
      const pH = Math.round(s.perfect/s.total*120);
      const paH = Math.round(s.partial/s.total*120);
      const mH = Math.round(s.missed/s.total*120);
      col.innerHTML = `
        <div class="w-bar">
          ${pH ? `<div class="s-perf" style="height:${pH}px"></div>` : ''}
          ${paH ? `<div class="s-part" style="height:${paH}px"></div>` : ''}
          ${mH ? `<div class="s-miss" style="height:${mH}px"></div>` : ''}
        </div>
        <span class="w-label">${wkdNames[d]}</span>
      `;
    }
    col.title = `${wkdNames[d]}: ${s.perfect} perfect, ${s.partial} partial, ${s.missed} missed`;
    wkdEl.appendChild(col);
  });

  // Mood chart
  const moodEl = $('#moodChart');
  const counts = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  dates.forEach(ds => { const m = state.moods[ds]; if (m) counts[m.value]++; });
  const maxCount = Math.max(1, ...Object.values(counts));
  const totalM = Object.values(counts).reduce((a,b)=>a+b,0);
  if (totalM === 0) {
    moodEl.innerHTML = `<div class="mood-chart-empty">No mood logs yet. Tap a mood on the Journal tab to get started.</div>`;
  } else {
    moodEl.innerHTML = [5,4,3,2,1].map(v => `
      <div class="m-row" data-mood="${v}">
        <span class="m-emoji">${MOOD_META[v].emoji}</span>
        <div class="m-bar"><div class="m-fill" style="width:${counts[v]/maxCount*100}%"></div></div>
        <span class="m-count">${counts[v]}</span>
      </div>
    `).join('');
  }

  // Heatmap — 12 weeks always
  renderHeatmap();

  // Per-habit list
  const phList = $('#perhabitList');
  phList.innerHTML = '';
  if (state.habits.length === 0) {
    phList.innerHTML = `<div class="session-empty">Add habits to see per-habit stats.</div>`;
  } else {
    state.habits.forEach(h => {
      const { rate } = habitCompletionRate(h, n);
      const { current } = computeStreaks(h);
      const row = document.createElement('div');
      row.className = 'perhabit-row';
      row.style.setProperty('--habit-color', colorValue(h.color));
      row.innerHTML = `
        <span class="ph-ic">${h.icon || '•'}</span>
        <span class="ph-name">${escapeHtml(h.name)}</span>
        <span class="ph-rate">${Math.round(rate*100)}%</span>
        <span class="ph-streak">🔥 ${current}</span>
      `;
      phList.appendChild(row);
    });
  }
}

function renderHeatmap() {
  const el = $('#heatmap');
  el.innerHTML = '';
  const today = new Date(); today.setHours(0,0,0,0);
  const daysSinceSun = today.getDay();
  const end = addDays(today, 6 - daysSinceSun);
  const start = addDays(end, -(12*7 - 1));
  for (let i = 0; i < 12*7; i++) {
    const d = addDays(start, i);
    const ds = fmtDate(d);
    const isFuture = d > today;
    const { scheduled, done } = dayCompletion(ds);
    const pct = scheduled === 0 ? 0 : done/scheduled;
    let level = 0;
    if (!isFuture && scheduled > 0) {
      if (pct >= 1) level = 4;
      else if (pct >= 0.75) level = 3;
      else if (pct >= 0.5) level = 2;
      else if (pct > 0) level = 1;
    }
    const cell = document.createElement('div');
    cell.className = 'cell' + (isFuture ? ' future' : '') + (level ? ' l' + level : '');
    cell.title = `${d.toLocaleDateString(undefined, { month:'short', day:'numeric' })} · ${isFuture ? 'upcoming' : (scheduled === 0 ? 'no habits' : `${done}/${scheduled} done`)}`;
    el.appendChild(cell);
  }
}

/* ========================================================== *
 *  TIMER TAB
 * ========================================================== */

function renderTimer() {
  const sel = $('#timerHabit');
  const keepId = ui.timer.habitId;
  sel.innerHTML = '';
  if (state.habits.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No habits yet';
    sel.appendChild(opt);
    sel.disabled = true;
  } else {
    sel.disabled = false;
    state.habits.forEach(h => {
      const o = document.createElement('option');
      o.value = h.id;
      o.textContent = `${h.icon || '•'}  ${h.name}`;
      sel.appendChild(o);
    });
    if (keepId && state.habits.find(h => h.id === keepId)) sel.value = keepId;
    else ui.timer.habitId = sel.value;
  }
  updateTimerDisplay();
  renderSessions();
}

function updateTimerDisplay() {
  const t = ui.timer;
  const mm = Math.floor(t.remainingSec / 60);
  const ss = t.remainingSec % 60;
  $('#timerTime').textContent = `${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  $('#timerStatus').textContent = t.running ? 'Focusing' : (t.remainingSec === t.durationSec ? 'Ready' : 'Paused');
  $('#timerToggle').textContent = t.running ? 'Pause' : (t.remainingSec === t.durationSec ? 'Start' : 'Resume');
  const progress = 1 - (t.remainingSec / t.durationSec);
  $('#ringFill').style.strokeDashoffset = String(100 - progress * 100);
  $('#timerLog').disabled = t.running || t.remainingSec === t.durationSec;
}

function renderSessions() {
  const el = $('#sessionList');
  const t = todayISO();
  const todays = state.sessions.filter(s => fmtDate(new Date(s.completedAt)) === t).sort((a,b) => b.completedAt - a.completedAt);
  if (todays.length === 0) {
    el.innerHTML = `<div class="session-empty">No focus sessions yet today. Start the timer to log one.</div>`;
    return;
  }
  el.innerHTML = todays.map(s => {
    const h = habitById(s.habitId);
    const mins = Math.round(s.seconds / 60);
    const when = new Date(s.completedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `
      <div class="session-item">
        <span class="s-name">${h ? `${h.icon || '•'} ${escapeHtml(h.name)}` : 'Unknown habit'}</span>
        <span class="s-time">${mins} min · ${when}</span>
      </div>
    `;
  }).join('');
}

/* ========================================================== *
 *  ROOT RENDER + TAB SWITCH
 * ========================================================== */
function renderAll() {
  renderTopLabel();
  renderDateStrip();
  if (ui.tab === 'journal')  renderJournal();
  if (ui.tab === 'progress') renderProgress();
  if (ui.tab === 'timer')    renderTimer();
}

function switchTab(name) {
  ui.tab = name;
  $$('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tabpanel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== name));
  // date strip is only relevant to journal
  $('#dateStrip').style.display = name === 'journal' ? '' : 'none';
  renderAll();
}

/* ========================================================== *
 *  INTERACTIONS
 * ========================================================== */

/* ---------- Habit modal ---------- */
function openHabitModal(habit) {
  ui.editingHabit = habit?.id || null;
  $('#modalTitle').textContent = habit ? 'Edit habit' : 'New habit';
  $('#saveBtn').textContent = habit ? 'Save changes' : 'Create habit';
  $('#deleteBtn').classList.toggle('hidden', !habit);
  $('#templatesField').classList.toggle('hidden', !!habit);

  if (habit) {
    ui.draft = {
      name: habit.name, icon: habit.icon || '🏋️', color: habit.color,
      areaId: habit.areaId || null, tod: habit.tod || 'any',
      days: [...habit.days], goalType: habit.goalType, target: habit.target || 8, unit: habit.unit || ''
    };
  } else {
    ui.draft = {
      name: '', icon: '🏋️', color: 'teal', areaId: null, tod: 'any',
      days: [0,1,2,3,4,5,6], goalType: 'simple', target: 8, unit: ''
    };
  }
  syncHabitModal();
  $('#habitModal').classList.remove('hidden');
  setTimeout(() => $('#habitName').focus(), 80);
}

function syncHabitModal() {
  const d = ui.draft;
  $('#habitName').value = d.name;
  // Icon row
  const ir = $('#iconRow'); ir.innerHTML = '';
  ICONS.forEach(ic => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'icon-btn' + (d.icon === ic ? ' selected' : '');
    b.textContent = ic;
    b.addEventListener('click', () => { d.icon = ic; syncHabitModal(); });
    ir.appendChild(b);
  });
  // Color row
  const cr = $('#colorRow'); cr.innerHTML = '';
  COLORS.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'color-swatch' + (d.color === c.name ? ' selected' : '');
    b.style.setProperty('--c', `var(${c.var})`);
    b.setAttribute('aria-label', c.name);
    b.addEventListener('click', () => { d.color = c.name; syncHabitModal(); });
    cr.appendChild(b);
  });
  // Goal type
  $$('[data-goaltype]').forEach(b => b.classList.toggle('on', b.dataset.goaltype === d.goalType));
  $('#countField').classList.toggle('hidden', d.goalType !== 'count');
  $('#habitTarget').value = d.target;
  $('#habitUnit').value = d.unit || '';
  // Area
  const ar = $('#areaPicker'); ar.innerHTML = '';
  const none = document.createElement('button');
  none.type = 'button'; none.className = 'area-opt none' + (!d.areaId ? ' on' : '');
  none.textContent = 'No area';
  none.addEventListener('click', () => { d.areaId = null; syncHabitModal(); });
  ar.appendChild(none);
  state.areas.forEach(a => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'area-opt' + (d.areaId === a.id ? ' on' : '');
    b.style.setProperty('--a-color', colorValue(a.color));
    b.textContent = a.name;
    b.addEventListener('click', () => { d.areaId = a.id; syncHabitModal(); });
    ar.appendChild(b);
  });
  // TOD
  $$('#todPicker [data-tod]').forEach(b => b.classList.toggle('on', b.dataset.tod === d.tod));
  // Days
  $$('#dayRow button').forEach(b => {
    const dd = Number(b.dataset.day);
    b.classList.toggle('on', d.days.includes(dd));
  });
  // Templates
  const tg = $('#templateGrid');
  if (tg && !$('#templateGrid button')) {
    TEMPLATES.forEach(t => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tpl-btn';
      b.innerHTML = `<span class="tpl-ic">${t.icon}</span><span>${escapeHtml(t.name)}</span>`;
      b.addEventListener('click', () => {
        Object.assign(ui.draft, {
          name: t.name, icon: t.icon, goalType: t.goalType, tod: t.tod,
          target: t.target || ui.draft.target, unit: t.unit || ui.draft.unit
        });
        syncHabitModal();
      });
      tg.appendChild(b);
    });
  }
}

function closeModal(id) { $('#' + id).classList.add('hidden'); }

/* ---------- Note / status sheet ---------- */
function openNoteSheet(habitId, dateStr) {
  const h = habitById(habitId);
  if (!h) return;
  ui.noteFor = { habitId, date: dateStr };
  $('#noteTitle').textContent = `${h.icon || ''} ${h.name}`;
  const log = getLog(habitId, dateStr) || { status: 'none', count: 0, note: '' };
  $('#countLogField').classList.toggle('hidden', h.goalType !== 'count');
  $('#countCurrent').textContent = log.count || 0;
  $('#countUnit').textContent = h.goalType === 'count' ? `of ${h.target} ${h.unit || ''}` : '';
  $('#noteText').value = log.note || '';
  $$('#statusRow .status-btn').forEach(b => b.classList.toggle('on', b.dataset.status === log.status));
  $('#noteModal').classList.remove('hidden');
  setTimeout(() => $('#noteText').focus(), 80);
}

/* ---------- Area modal ---------- */
function openAreaModal(area) {
  ui.editingArea = area?.id || null;
  $('#areaModalTitle').textContent = area ? 'Edit area' : 'New area';
  $('#areaDeleteBtn').classList.toggle('hidden', !area);
  $('#areaName').value = area?.name || '';
  const draftColor = area?.color || 'indigo';
  const cr = $('#areaColorRow'); cr.innerHTML = '';
  COLORS.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'color-swatch' + (draftColor === c.name ? ' selected' : '');
    b.style.setProperty('--c', `var(${c.var})`);
    b.dataset.color = c.name;
    b.addEventListener('click', () => {
      $$('#areaColorRow .color-swatch').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
    });
    cr.appendChild(b);
  });
  $('#areaModal').classList.remove('hidden');
  setTimeout(() => $('#areaName').focus(), 80);
}

/* ---------- Mood modal ---------- */
function openMoodModal(preset) {
  ui.moodDraft = preset ? { value: preset, note: state.moods[ui.selectedDate]?.note || '' } : (state.moods[ui.selectedDate] ? { ...state.moods[ui.selectedDate] } : null);
  $$('#moodBig .mood-b').forEach(b => b.classList.toggle('on', ui.moodDraft && Number(b.dataset.mood) === ui.moodDraft.value));
  $('#moodNote').value = ui.moodDraft?.note || '';
  $('#moodSave').disabled = !ui.moodDraft;
  $('#moodModal').classList.remove('hidden');
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- Theme ---------- */
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

/* ---------- Event wiring ---------- */
function bindEvents() {
  // Tabs
  $$('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // Journal: TOD
  $$('#todBar .tod-btn').forEach(b => b.addEventListener('click', () => {
    ui.tod = b.dataset.tod; renderJournal();
  }));

  // Progress range
  $$('.range-btn').forEach(b => b.addEventListener('click', () => {
    $$('.range-btn').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    ui.range = Number(b.dataset.range);
    renderProgress();
  }));

  // Mood strip quick log
  $$('#moodStrip .mood').forEach(b => b.addEventListener('click', () => {
    openMoodModal(Number(b.dataset.mood));
  }));

  // FAB
  $('#fabBtn').addEventListener('click', () => {
    $('#newMenu').classList.remove('hidden');
  });
  $$('#newMenu .menu-item').forEach(b => b.addEventListener('click', () => {
    const kind = b.dataset.new;
    $('#newMenu').classList.add('hidden');
    if (kind === 'habit') openHabitModal(null);
    if (kind === 'mood')  openMoodModal(null);
    if (kind === 'area')  openAreaModal(null);
  }));

  // Export
  $('#exportBtn').addEventListener('click', () => {
    const data = JSON.stringify(state, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `cadence-${todayISO()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('Data exported');
  });

  // Close modals via backdrop/close buttons
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) {
      const modal = e.target.closest('.modal');
      if (modal) modal.classList.add('hidden');
    }
    // Check button (toggle done)
    const checkEl = e.target.closest('[data-check]');
    if (checkEl) {
      const id = checkEl.dataset.check;
      const h = habitById(id);
      if (!h) return;
      const log = getLog(id, ui.selectedDate);
      if (h.goalType === 'count') {
        // increment count by 1; if reached target, done.
        const cur = log?.count || 0;
        const next = cur + 1;
        setLog(id, ui.selectedDate, { count: next, status: next >= h.target ? 'done' : 'none' });
      } else {
        const done = isDoneLog(h, log);
        setLog(id, ui.selectedDate, { status: done ? 'none' : 'done' });
      }
      renderAll();
      return;
    }
    // Row menu → open note/status sheet
    const menuEl = e.target.closest('[data-menu]');
    if (menuEl) {
      openNoteSheet(menuEl.dataset.menu, ui.selectedDate);
      return;
    }
  });

  // Long-press on check → open note sheet
  let pressTimer, pressedId;
  $('#habitList').addEventListener('pointerdown', (e) => {
    const c = e.target.closest('[data-check]');
    if (!c) return;
    pressedId = c.dataset.check;
    pressTimer = setTimeout(() => {
      openNoteSheet(pressedId, ui.selectedDate);
      pressedId = null;
    }, 550);
  });
  const clearPress = () => { clearTimeout(pressTimer); pressedId = null; };
  $('#habitList').addEventListener('pointerup', clearPress);
  $('#habitList').addEventListener('pointerleave', clearPress);
  $('#habitList').addEventListener('pointercancel', clearPress);

  // Esc to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal').forEach(m => m.classList.add('hidden'));
  });

  /* ----- Habit modal ----- */
  $$('[data-goaltype]').forEach(b => b.addEventListener('click', () => {
    ui.draft.goalType = b.dataset.goaltype;
    syncHabitModal();
  }));
  $('#habitTarget').addEventListener('input', (e) => { ui.draft.target = Math.max(1, Number(e.target.value) || 1); });
  $('#habitUnit').addEventListener('input', (e) => { ui.draft.unit = e.target.value; });
  $('#habitName').addEventListener('input', (e) => { ui.draft.name = e.target.value; });
  $$('#todPicker [data-tod]').forEach(b => b.addEventListener('click', () => {
    ui.draft.tod = b.dataset.tod; syncHabitModal();
  }));
  $('#dayRow').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-day]'); if (!b) return;
    const d = Number(b.dataset.day);
    if (ui.draft.days.includes(d)) ui.draft.days = ui.draft.days.filter(x => x !== d);
    else ui.draft.days = [...ui.draft.days, d];
    syncHabitModal();
  });
  $$('.preset-row .chip').forEach(c => c.addEventListener('click', () => {
    if (c.dataset.preset === 'daily') ui.draft.days = [0,1,2,3,4,5,6];
    if (c.dataset.preset === 'weekdays') ui.draft.days = [1,2,3,4,5];
    if (c.dataset.preset === 'weekends') ui.draft.days = [0,6];
    syncHabitModal();
  }));

  $('#habitForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const d = ui.draft;
    if (!d.name.trim()) return;
    if (d.days.length === 0) { toast('Pick at least one day'); return; }
    if (d.goalType === 'count' && (!d.target || d.target < 1)) { toast('Set a daily target'); return; }
    if (ui.editingHabit) {
      const h = habitById(ui.editingHabit);
      if (h) {
        h.name = d.name.trim(); h.icon = d.icon; h.color = d.color;
        h.areaId = d.areaId; h.tod = d.tod;
        h.days = [...d.days].sort();
        h.goalType = d.goalType;
        if (d.goalType === 'count') { h.target = Number(d.target); h.unit = d.unit || ''; } else { delete h.target; delete h.unit; }
      }
      toast('Habit updated');
    } else {
      const newHabit = {
        id: uid('h'),
        name: d.name.trim(), icon: d.icon, color: d.color,
        areaId: d.areaId, tod: d.tod,
        days: [...d.days].sort(), goalType: d.goalType,
        createdAt: todayISO(), priority: state.habits.length + 1,
      };
      if (d.goalType === 'count') { newHabit.target = Number(d.target); newHabit.unit = d.unit || ''; }
      state.habits.push(newHabit);
      toast('Habit created');
    }
    save();
    closeModal('habitModal');
    renderAll();
  });

  $('#deleteBtn').addEventListener('click', () => {
    if (!ui.editingHabit) return;
    const h = habitById(ui.editingHabit);
    if (!h) return;
    if (!confirm(`Delete "${h.name}"? All logged history for this habit will be removed.`)) return;
    state.habits = state.habits.filter(x => x.id !== ui.editingHabit);
    delete state.logs[ui.editingHabit];
    state.sessions = state.sessions.filter(s => s.habitId !== ui.editingHabit);
    save();
    closeModal('habitModal');
    renderAll();
    toast('Habit deleted');
  });

  /* ----- Note sheet ----- */
  $$('#statusRow .status-btn').forEach(b => b.addEventListener('click', () => {
    if (!ui.noteFor) return;
    const { habitId, date } = ui.noteFor;
    const h = habitById(habitId);
    const status = b.dataset.status;
    $$('#statusRow .status-btn').forEach(x => x.classList.remove('on'));
    if (status === 'clear') {
      // Clear everything for the day
      if (state.logs[habitId]) delete state.logs[habitId][date];
      save();
      closeModal('noteModal');
      renderAll();
      toast('Log cleared');
      return;
    }
    b.classList.add('on');
    const note = $('#noteText').value;
    const patch = { status, note };
    if (h.goalType === 'count' && status === 'done') patch.count = h.target;
    if (status !== 'done' && h.goalType !== 'count') patch.count = 0;
    setLog(habitId, date, patch);
    renderAll();
  }));
  $('#countMinus').addEventListener('click', () => {
    if (!ui.noteFor) return;
    const { habitId, date } = ui.noteFor;
    const log = getLog(habitId, date) || { count: 0 };
    const next = Math.max(0, (log.count || 0) - 1);
    const h = habitById(habitId);
    setLog(habitId, date, { count: next, status: next >= h.target ? 'done' : (next === 0 ? 'none' : 'none') });
    $('#countCurrent').textContent = next;
    renderAll();
  });
  $('#countPlus').addEventListener('click', () => {
    if (!ui.noteFor) return;
    const { habitId, date } = ui.noteFor;
    const log = getLog(habitId, date) || { count: 0 };
    const h = habitById(habitId);
    const next = (log.count || 0) + 1;
    setLog(habitId, date, { count: next, status: next >= h.target ? 'done' : 'none' });
    $('#countCurrent').textContent = next;
    renderAll();
  });
  $('#noteSave').addEventListener('click', () => {
    if (!ui.noteFor) return;
    const { habitId, date } = ui.noteFor;
    const note = $('#noteText').value;
    setLog(habitId, date, { note });
    closeModal('noteModal');
    renderAll();
    toast('Saved');
  });

  /* ----- Mood modal ----- */
  $$('#moodBig .mood-b').forEach(b => b.addEventListener('click', () => {
    const v = Number(b.dataset.mood);
    ui.moodDraft = { value: v, note: $('#moodNote').value };
    $$('#moodBig .mood-b').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    $('#moodSave').disabled = false;
  }));
  $('#moodNote').addEventListener('input', (e) => {
    if (ui.moodDraft) ui.moodDraft.note = e.target.value;
  });
  $('#moodSave').addEventListener('click', () => {
    if (!ui.moodDraft) return;
    state.moods[ui.selectedDate] = { value: ui.moodDraft.value, note: ui.moodDraft.note || '', timestamp: Date.now() };
    save();
    closeModal('moodModal');
    renderAll();
    toast('Mood logged');
  });

  /* ----- Area modal ----- */
  $('#areaForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#areaName').value.trim();
    const color = ($('#areaColorRow .selected')?.dataset.color) || 'indigo';
    if (!name) return;
    if (ui.editingArea) {
      const a = areaById(ui.editingArea);
      if (a) { a.name = name; a.color = color; }
    } else {
      state.areas.push({ id: uid('a'), name, color });
    }
    save();
    closeModal('areaModal');
    renderAll();
    toast(ui.editingArea ? 'Area updated' : 'Area created');
  });
  $('#areaDeleteBtn').addEventListener('click', () => {
    if (!ui.editingArea) return;
    if (!confirm('Delete this area? Habits in this area will become unsorted.')) return;
    state.habits.forEach(h => { if (h.areaId === ui.editingArea) h.areaId = null; });
    state.areas = state.areas.filter(a => a.id !== ui.editingArea);
    save();
    closeModal('areaModal');
    renderAll();
    toast('Area deleted');
  });

  /* ----- Timer ----- */
  $('#timerHabit').addEventListener('change', (e) => { ui.timer.habitId = e.target.value; });
  $$('.mode-btn').forEach(b => b.addEventListener('click', () => {
    $$('.mode-btn').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    const mins = Number(b.dataset.min);
    ui.timer.durationSec = mins * 60;
    if (!ui.timer.running) ui.timer.remainingSec = ui.timer.durationSec;
    updateTimerDisplay();
  }));
  $('#timerToggle').addEventListener('click', () => {
    if (state.habits.length === 0) { toast('Add a habit first'); return; }
    const t = ui.timer;
    if (!t.habitId) t.habitId = state.habits[0].id;
    if (t.running) {
      clearInterval(t.intervalId);
      t.running = false;
    } else {
      if (t.remainingSec === t.durationSec) t.startedAt = Date.now();
      t.running = true;
      t.intervalId = setInterval(() => {
        t.remainingSec--;
        if (t.remainingSec <= 0) {
          clearInterval(t.intervalId);
          t.running = false;
          const seconds = t.durationSec;
          state.sessions.push({ id: uid('s'), habitId: t.habitId, seconds, completedAt: Date.now() });
          save();
          t.remainingSec = t.durationSec;
          toast('Focus session complete');
          renderSessions();
        }
        updateTimerDisplay();
      }, 1000);
    }
    updateTimerDisplay();
  });
  $('#timerReset').addEventListener('click', () => {
    const t = ui.timer;
    clearInterval(t.intervalId);
    t.running = false;
    t.remainingSec = t.durationSec;
    updateTimerDisplay();
  });
  $('#timerLog').addEventListener('click', () => {
    const t = ui.timer;
    if (!t.habitId) return;
    const seconds = t.durationSec - t.remainingSec;
    if (seconds < 30) { toast('Focus at least 30s'); return; }
    state.sessions.push({ id: uid('s'), habitId: t.habitId, seconds, completedAt: Date.now() });
    save();
    t.remainingSec = t.durationSec;
    clearInterval(t.intervalId);
    t.running = false;
    updateTimerDisplay();
    renderSessions();
    toast('Session logged');
  });
}

/* ========================================================== *
 *  INIT
 * ========================================================== */
load();
seedIfEmpty();
// Auto-select current TOD on first render
ui.tod = 'all';  // default to All so new users see everything
bindEvents();
renderAll();
switchTab('journal');
initAuth();

/* ---------- Auth + remote sync wiring ---------- */
function initAuth() {
  const authBtn = document.getElementById('authBtn');
  if (!authBtn) return;
  const sync = window.cadenceSync;

  if (!sync || !sync.available) {
    // Firebase not configured: hide sign-in entirely, stay local-only
    authBtn.hidden = true;
    return;
  }
  authBtn.hidden = false;
  setSyncState('signedout');

  authBtn.addEventListener('click', async () => {
    if (sync.user) {
      if (confirm('Sign out of Cadence?\n\nYour data stays on this device; cloud sync will pause until you sign in again.')) {
        await sync.signOut();
      }
    } else {
      setSyncState('saving');
      const u = await sync.signIn();
      if (!u) setSyncState('signedout');
    }
  });

  sync.onAuthChange(async (user) => {
    if (user) {
      // Show avatar/initials on the button
      const initial = (user.displayName || user.email || '?').trim().charAt(0).toUpperCase();
      authBtn.innerHTML = user.photoURL
        ? `<img src="${user.photoURL}" alt="" style="width:24px;height:24px;border-radius:50%;" referrerpolicy="no-referrer" />`
        : `<span style="width:24px;height:24px;border-radius:50%;background:var(--color-primary);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;">${initial}</span>`;
      authBtn.title = 'Signed in as ' + (user.displayName || user.email || '') + ' — click to sign out';

      setSyncState('saving');
      try {
        const remote = await sync.pullRemote();
        if (remote) {
          // Merge strategy: if remote has more habits/logs than local, prefer remote.
          const localCount = (state.habits?.length || 0) + Object.keys(state.logs || {}).length;
          const remoteCount = (remote.habits?.length || 0) + Object.keys(remote.logs || {}).length;
          if (remoteCount >= localCount) {
            state = remote;
            state.areas = state.areas || [];
            state.habits = state.habits || [];
            state.logs = state.logs || {};
            state.moods = state.moods || {};
            state.sessions = state.sessions || [];
            state.settings = state.settings || { timeRanges: DEFAULT_TOD };
            safeStorage.set(STORAGE_KEY, JSON.stringify(state));
            showToast('Synced from cloud');
          } else {
            // local wins → push it up
            sync.pushRemote(state);
          }
        } else {
          // First time on this account → seed with current local data
          sync.pushRemote(state);
        }
        renderAll();
        setSyncState('synced');
      } catch (e) {
        console.warn(e);
        setSyncState('error');
      }

      // Live updates from other devices
      sync.subscribeRemote((incoming) => {
        try {
          const curStr = JSON.stringify(state);
          const newStr = JSON.stringify(incoming);
          if (curStr === newStr) return;
          state = incoming;
          state.areas = state.areas || [];
          state.habits = state.habits || [];
          state.logs = state.logs || {};
          state.moods = state.moods || {};
          state.sessions = state.sessions || [];
          state.settings = state.settings || { timeRanges: DEFAULT_TOD };
          safeStorage.set(STORAGE_KEY, JSON.stringify(state));
          renderAll();
          setSyncState('synced');
        } catch (e) {}
      });
    } else {
      // Signed out
      authBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
      authBtn.title = 'Sign in with Google';
      setSyncState('signedout');
    }
  });
}

// Refresh at midnight
(function midnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0, 0, 5);
  setTimeout(() => { ui.selectedDate = todayISO(); renderAll(); midnight(); }, next - now);
})();
