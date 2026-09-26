// Présences (comme l'application Présences d'Odoo) : arrivée / départ, tableau de l'équipe,
// rapport des heures prévues / travaillées / supplémentaires, départ automatique en cas d'oubli.
import { db, all, get, run, insert, update, tx, round2, today, localDate, localDateTime, getSettings } from './db.js';
import { durationHours, BusinessError } from './business.js';

if (!all('PRAGMA table_info(users)').some((c) => c.name === 'badge')) db.exec('ALTER TABLE users ADD COLUMN badge TEXT');
if (!all('PRAGMA table_info(time_entries)').some((c) => c.name === 'source')) db.exec('ALTER TABLE time_entries ADD COLUMN source TEXT');

export const ATTENDANCE_DEFAULTS = { hours_per_day: 8, work_days: [1, 2, 3, 4, 5], tolerance_min: 10, auto_checkout: true, kiosk_pin: true, kiosk_badge: true, kiosk_show_orders: true };
export const attendanceConfig = () => ({ ...ATTENDANCE_DEFAULTS, ...(getSettings().attendance || {}) });

const openPresence = (userId) => get("SELECT * FROM time_entries WHERE user_id=? AND kind='presence' AND end IS NULL ORDER BY start DESC LIMIT 1", userId);
const sumHours = (rows) => round2(rows.reduce((s, t) => s + durationHours(t), 0));

export function hoursOn(userId, date) {
  return sumHours(all("SELECT * FROM time_entries WHERE user_id=? AND kind='presence' AND substr(start,1,10)=?", userId, date));
}
function weekStart(date = today()) {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDate(d);
}
const isWorkDay = (date, cfg) => cfg.work_days.includes(new Date(date + 'T12:00:00').getDay());

/** Situation d'une personne : présente ou non, depuis quand, heures du jour et de la semaine. */
export function statusOf(userId) {
  const cfg = attendanceConfig();
  const open = openPresence(userId);
  const t = today();
  const week = sumHours(all("SELECT * FROM time_entries WHERE user_id=? AND kind='presence' AND substr(start,1,10) BETWEEN ? AND ?", userId, weekStart(t), t));
  return {
    present: Boolean(open), since: open?.start || null, today_hours: hoursOn(userId, t), week_hours: week,
    expected_today: isWorkDay(t, cfg) ? cfg.hours_per_day : 0,
    last: get("SELECT * FROM time_entries WHERE user_id=? AND kind='presence' ORDER BY start DESC LIMIT 1", userId) || null,
  };
}

/** Arrivée ou départ (bascule), comme le gros bouton d'Odoo. `action` force 'in' ou 'out'. */
export function checkInOut(userId, { action, source = 'web' } = {}) {
  const now = localDateTime();
  return tx(() => {
    const open = openPresence(userId);
    const want = action || (open ? 'out' : 'in');
    if (want === 'in') {
      if (!open) insert('time_entries', { user_id: userId, kind: 'presence', start: now, source }, ['user_id', 'kind', 'start', 'source']);
    } else {
      if (!open) throw new BusinessError('Vous n\'êtes pas pointé(e)');
      run("UPDATE time_entries SET end=? WHERE user_id=? AND kind='work' AND end IS NULL", now, userId);
      run('UPDATE time_entries SET end=? WHERE id=?', now, open.id);
    }
    const u = get('SELECT id, name, color FROM users WHERE id=?', userId);
    return { action: want, at: now, user: u, ...statusOf(userId) };
  });
}

/** L'équipe en un coup d'œil (tableau « Présences »). */
export function board() {
  const t = today();
  const rows = all(`SELECT u.id, u.name, u.color, u.role, u.job_title,
      (SELECT start FROM time_entries t WHERE t.user_id=u.id AND t.kind='presence' AND t.end IS NULL ORDER BY start DESC LIMIT 1) AS since,
      (SELECT d.number FROM time_entries w JOIN documents d ON d.id=w.document_id WHERE w.user_id=u.id AND w.kind='work' AND w.end IS NULL LIMIT 1) AS working_on,
      (SELECT MIN(start) FROM time_entries t WHERE t.user_id=u.id AND t.kind='presence' AND substr(t.start,1,10)=?) AS first_in
    FROM users u WHERE u.active=1 ORDER BY u.name`, t);
  return rows.map((r) => ({ ...r, present: Boolean(r.since), today_hours: hoursOn(r.id, t) }));
}

/** Liste des pointages (avec durée), filtrable par période et par personne. */
export function listAttendance({ from = today(), to = today(), user_id } = {}) {
  const rows = all(`SELECT t.*, u.name AS user_name, u.color FROM time_entries t JOIN users u ON u.id=t.user_id
    WHERE t.kind='presence' AND substr(t.start,1,10) BETWEEN ? AND ? ${user_id ? 'AND t.user_id=?' : ''} ORDER BY t.start DESC`, from, to, ...(user_id ? [Number(user_id)] : []));
  return rows.map((r) => ({ ...r, hours: round2(durationHours(r)) }));
}

/** Rapport par personne : jours travaillés, heures prévues, travaillées et supplémentaires. */
export function attendanceReport({ from = weekStart(), to = today() } = {}) {
  const cfg = attendanceConfig();
  const days = [];
  for (let d = new Date(from + 'T12:00:00'); localDate(d) <= to; d.setDate(d.getDate() + 1)) days.push(localDate(d));
  const expectedDays = days.filter((d) => isWorkDay(d, cfg) && d <= today()).length;
  const entries = listAttendance({ from, to });
  const users = all('SELECT id, name, color, role FROM users WHERE active=1 ORDER BY name');
  return users.map((u) => {
    const mine = entries.filter((e) => e.user_id === u.id);
    const byDay = {};
    for (const e of mine) byDay[e.start.slice(0, 10)] = round2((byDay[e.start.slice(0, 10)] || 0) + e.hours);
    const worked = round2(Object.values(byDay).reduce((s, h) => s + h, 0));
    const expected = round2(expectedDays * cfg.hours_per_day);
    const late = mine.filter((e) => {
      const first = mine.filter((x) => x.start.slice(0, 10) === e.start.slice(0, 10)).sort((a, b) => a.start.localeCompare(b.start))[0];
      return first === e && e.start.slice(11, 16) > addMinutes(getSettings().workshop?.opening || '08:00', cfg.tolerance_min);
    }).length;
    return { user_id: u.id, name: u.name, color: u.color, role: u.role, days: Object.keys(byDay).length, worked, expected, overtime: round2(worked - expected), late, by_day: byDay };
  }).filter((r) => r.days || r.role !== 'admin');
}
function addMinutes(hhmm, min) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + Number(min || 0);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// Corrections par un responsable
const valid = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s || '');
export function saveAttendance(data, id = null) {
  if (!data.user_id && !id) throw new BusinessError('Employé requis');
  if (!valid(data.start)) throw new BusinessError('Heure d\'arrivée invalide');
  if (data.end && !valid(data.end)) throw new BusinessError('Heure de départ invalide');
  if (data.end && data.end <= data.start) throw new BusinessError('Le départ doit être après l\'arrivée');
  const row = { start: data.start, end: data.end || null, note: data.note || null };
  if (id) { update('time_entries', id, row, ['start', 'end', 'note']); return id; }
  return insert('time_entries', { ...row, user_id: Number(data.user_id), kind: 'presence', source: 'manual' }, ['user_id', 'kind', 'start', 'end', 'note', 'source']);
}

/** Départ automatique : un pointage oublié la veille est fermé après les heures prévues. */
export function autoCheckout() {
  const cfg = attendanceConfig();
  if (!cfg.auto_checkout) return 0;
  const t = today();
  const open = all("SELECT * FROM time_entries WHERE end IS NULL AND kind IN ('presence','work') AND substr(start,1,10) < ?", t);
  for (const e of open) {
    const start = new Date(e.start);
    const end = new Date(start.getTime() + cfg.hours_per_day * 3600e3);
    const dayEnd = new Date(e.start.slice(0, 10) + 'T23:59:00');
    run('UPDATE time_entries SET end=?, note=? WHERE id=?', localDateTime(end < dayEnd ? end : dayEnd), [e.note, 'Départ automatique (pointage oublié)'].filter(Boolean).join(' · '), e.id);
  }
  return open.length;
}
