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
  if (action && !['in', 'out'].includes(action)) throw new BusinessError('Action inconnue');
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
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(new Date(d + 'T12:00:00').getTime());
/** Période demandée dans l'adresse : dates réelles, dans l'ordre, 2 ans maximum (sinon le rapport bloquerait le serveur). */
export function period(from, to) {
  if (!isDate(from) || !isDate(to)) throw new BusinessError('Période invalide : utilisez des dates au format AAAA-MM-JJ');
  if (to < from) throw new BusinessError('La date de fin est avant la date de début');
  if ((new Date(to + 'T12:00:00') - new Date(from + 'T12:00:00')) / 864e5 > 731) throw new BusinessError('Période trop longue : 2 ans maximum');
  return { from, to };
}

export function listAttendance({ from = today(), to = today(), user_id } = {}) {
  ({ from, to } = period(from, to));
  const rows = all(`SELECT t.*, u.name AS user_name, u.color FROM time_entries t JOIN users u ON u.id=t.user_id
    WHERE t.kind='presence' AND substr(t.start,1,10) BETWEEN ? AND ? ${user_id ? 'AND t.user_id=?' : ''} ORDER BY t.start DESC`, from, to, ...(user_id ? [Number(user_id)] : []));
  return rows.map((r) => ({ ...r, hours: round2(durationHours(r)) }));
}

/** Rapport par personne : jours travaillés, heures prévues, travaillées et supplémentaires. */
export function attendanceReport({ from = weekStart(), to = today() } = {}) {
  ({ from, to } = period(from, to));
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
      // un retard ne se compte que les jours travaillés (pas le samedi d'heures supplémentaires)
      return first === e && isWorkDay(e.start.slice(0, 10), cfg) && e.start.slice(11, 16) > addMinutes(getSettings().workshop?.opening || '08:00', cfg.tolerance_min);
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
const valid = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s || '') && !Number.isNaN(new Date(s).getTime());
export const validDateTime = valid;
export function saveAttendance(data, id = null) {
  if (!data.user_id && !id) throw new BusinessError('Employé requis');
  if (!valid(data.start)) throw new BusinessError('Heure d\'arrivée invalide');
  if (data.end && !valid(data.end)) throw new BusinessError('Heure de départ invalide');
  if (data.end && data.end <= data.start) throw new BusinessError('Le départ doit être après l\'arrivée');
  const cur = id ? get("SELECT * FROM time_entries WHERE id=? AND kind='presence'", id) : null;
  if (id && !cur) throw new BusinessError('Pointage introuvable', 404);
  const userId = cur ? cur.user_id : Number(data.user_id);
  if (!cur && !get('SELECT 1 FROM users WHERE id=?', userId)) throw new BusinessError('Employé inconnu');
  // Deux pointages de la même personne ne peuvent pas se chevaucher (les heures seraient comptées deux fois)
  if (get(`SELECT 1 FROM time_entries WHERE user_id=? AND kind='presence' AND id!=? AND start < ? AND COALESCE(end, '9999') > ?`, userId, id || 0, data.end || '9999', data.start)) {
    throw new BusinessError('Ce pointage chevauche un autre pointage de cette personne');
  }
  const row = { start: data.start, end: data.end || null, note: data.note || null };
  if (id) { update('time_entries', id, row, ['start', 'end', 'note']); return id; }
  return insert('time_entries', { ...row, user_id: Number(data.user_id), kind: 'presence', source: 'manual' }, ['user_id', 'kind', 'start', 'end', 'note', 'source']);
}

/**
 * Départ automatique : un pointage oublié est fermé après les heures prévues.
 * « Oublié » = ouvert depuis plus de 16 h (quelqu'un qui travaille encore après minuit n'est pas coupé).
 * Le départ est placé à la fin de la journée prévue, en tenant compte des heures déjà faites ce jour-là ;
 * un chrono de tâche oublié s'arrête au plus tard au départ de la personne.
 */
const FORGOTTEN_AFTER_H = 16;
export function autoCheckout() {
  const cfg = attendanceConfig();
  if (!cfg.auto_checkout) return 0;
  const limit = localDateTime(new Date(Date.now() - Math.max(FORGOTTEN_AFTER_H, Number(cfg.hours_per_day) || 0) * 3600e3));
  const note = (e, txt) => [e.note, txt].filter(Boolean).join(' · ');
  let n = 0;
  tx(() => {
    for (const e of all("SELECT * FROM time_entries WHERE end IS NULL AND kind='presence' AND start < ?", limit)) {
      const day = e.start.slice(0, 10);
      const done = sumHours(all("SELECT * FROM time_entries WHERE user_id=? AND kind='presence' AND end IS NOT NULL AND substr(start,1,10)=?", e.user_id, day));
      const remaining = Math.max(0, (Number(cfg.hours_per_day) || 0) - done);
      const end = localDateTime(new Date(new Date(e.start).getTime() + Math.max(60e3, remaining * 3600e3)));
      run('UPDATE time_entries SET end=?, note=? WHERE id=?', end, note(e, 'Départ automatique (pointage oublié)'), e.id);
      // les chronos de tâche restés ouverts s'arrêtent avec le départ (jamais avant leur propre début)
      for (const w of all("SELECT * FROM time_entries WHERE user_id=? AND kind='work' AND end IS NULL AND start < ?", e.user_id, end)) {
        run('UPDATE time_entries SET end=?, note=? WHERE id=?', end, note(w, 'Arrêt automatique (chrono oublié)'), w.id);
        n++;
      }
      n++;
    }
    // chrono de tâche ouvert sans pointage de présence ouvert : arrêté au départ de la personne, sinon durée nulle à corriger
    for (const w of all("SELECT * FROM time_entries w WHERE end IS NULL AND kind='work' AND start < ? AND NOT EXISTS (SELECT 1 FROM time_entries p WHERE p.user_id=w.user_id AND p.kind='presence' AND p.end IS NULL)", limit)) {
      const p = get("SELECT end FROM time_entries WHERE user_id=? AND kind='presence' AND start<=? AND end>? ORDER BY start DESC LIMIT 1", w.user_id, w.start, w.start);
      run('UPDATE time_entries SET end=?, note=? WHERE id=?', p?.end || w.start, note(w, 'Arrêt automatique (chrono oublié)'), w.id);
      n++;
    }
  });
  return n;
}
