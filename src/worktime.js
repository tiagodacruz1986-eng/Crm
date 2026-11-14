// Temps atelier : temps prévu et temps passé sur chaque intervention d'un ordre de réparation,
// dépassements, et statistiques par mécanicien (tableau de bord, feuilles de temps).
import { db, all, get, run, round2, localDateTime } from './db.js';

// Temps prévu par le gérant pour une intervention (en heures). Vide = heures vendues de la ligne de main-d'œuvre.
if (!all('PRAGMA table_info(document_lines)').some((c) => c.name === 'planned_hours')) db.exec('ALTER TABLE document_lines ADD COLUMN planned_hours REAL');
db.exec('CREATE INDEX IF NOT EXISTS idx_time_document ON time_entries(document_id)');

/** Une intervention = une ligne de main-d'œuvre ou un forfait (ni une pièce, ni un commentaire). */
export const isIntervention = (l) => !!l && (l.kind === 'labor' || l.kind === 'fee');

// 30 secondes de marge : un chrono arrêté pile à l'heure prévue n'est pas un dépassement
const TOLERANCE = 1 / 120;
export const isOver = (spent, planned) => planned > 0 && spent - planned > TOLERANCE;
const r4 = (n) => Math.round((Number(n) || 0) * 1e4) / 1e4;
const hoursOf = (t, now) => Math.max(0, (new Date(t.end || now) - new Date(t.start)) / 3600000);

/**
 * Temps prévu d'une intervention : celui saisi par le gérant ; sinon, pour la main-d'œuvre, les heures vendues.
 * 0 = pas de temps prévu (rien ne passera en rouge).
 */
export function plannedOf(l) {
  if (!isIntervention(l)) return null;
  if (l.planned_hours !== null && l.planned_hours !== undefined && l.planned_hours !== '') {
    const p = Number(l.planned_hours);
    return Number.isFinite(p) && p > 0 ? p : null;
  }
  const q = Number(l.quantity);
  return l.kind === 'labor' && q > 0 ? q : null;
}

/** Valeur enregistrée pour « temps prévu » : nombre d'heures entre 0 et 999, ou rien. */
export function cleanPlanned(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 999) return undefined; // invalide : à refuser par l'appelant
  return Math.round(n * 100) / 100;
}

const LINES_SQL = 'SELECT id, kind, description, quantity, planned_hours, done FROM document_lines WHERE document_id=? ORDER BY sequence, id';

/**
 * Temps d'un OR : par intervention (chronos démarrés sur la ligne) et au total.
 * Le temps pointé sur l'OR sans intervention précise est rangé dans « general ».
 */
export function orderTimes(docId, lines = null, now = localDateTime()) {
  const rows = lines || all(LINES_SQL, docId);
  const entries = all(`SELECT t.id, t.user_id, t.line_id, t.start, t.end, t.note, u.name AS user_name FROM time_entries t JOIN users u ON u.id=t.user_id
    WHERE t.document_id=? AND t.kind='work' ORDER BY t.start, t.id`, docId);
  const byLine = new Map(rows.filter(isIntervention).map((l) => [l.id, { planned: plannedOf(l), spent: 0, active: 0, workers: [] }]));
  const general = { spent: 0, active: 0, workers: [] };
  let spent = 0, active = 0;
  for (const e of entries) {
    const h = hoursOf(e, now);
    const slot = byLine.get(e.line_id) || general;
    e.hours = r4(h);
    e.on_line = slot !== general;
    slot.spent += h; spent += h;
    if (!e.end) { slot.active++; active++; if (!slot.workers.includes(e.user_name)) slot.workers.push(e.user_name); }
  }
  let planned = 0;
  for (const s of byLine.values()) planned += s.planned || 0;
  return { byLine, general, spent, active, planned: planned > 0 ? r4(planned) : null, entries };
}

/** Ajoute à un OR chargé (getDocument) le temps prévu / passé de chaque intervention et les totaux. */
export function attachTimes(d, now = localDateTime()) {
  const wt = orderTimes(d.id, d.lines, now);
  const names = new Map(d.lines.map((l) => [l.id, l.description]));
  for (const l of d.lines) {
    const s = wt.byLine.get(l.id);
    if (s) Object.assign(l, { planned: s.planned, spent: r4(s.spent), active: s.active, workers: s.workers });
  }
  d.time_entries = wt.entries.map((e) => ({ ...e, line_description: e.on_line ? names.get(e.line_id) || null : null }));
  d.hours_spent = r4(wt.spent);
  d.hours_planned = wt.planned;
  d.hours_general = r4(wt.general.spent);
  d.general_active = wt.general.active;
  d.general_workers = wt.general.workers;
  d.active_workers = wt.active;
  d.hours_sold = round2(d.lines.filter((l) => l.kind === 'labor').reduce((s, l) => s + Number(l.quantity || 0), 0));
  return d;
}

/** Lignes d'un OR pour la tablette de l'atelier : description, fait, temps prévu / passé, chronos en cours. */
export function kioskLines(docId, now = localDateTime()) {
  const lines = all(LINES_SQL, docId).filter((l) => l.kind !== 'text');
  const wt = orderTimes(docId, lines, now);
  return {
    lines: lines.map((l) => {
      const s = wt.byLine.get(l.id);
      return { id: l.id, kind: l.kind, description: l.description, quantity: l.quantity, done: l.done, timed: !!s,
        planned: s ? s.planned : null, spent: s ? r4(s.spent) : 0, active: s ? s.active : 0, workers: s ? s.workers : [] };
    }),
    hours_spent: r4(wt.spent), hours_planned: wt.planned, hours_general: r4(wt.general.spent), active: wt.active,
  };
}

/** Arrête les chronos en cours : sur une intervention (ligne) ou sur tout l'OR. */
export function stopLineTimers(docId, lineId, now = localDateTime()) {
  run("UPDATE time_entries SET end=? WHERE document_id=? AND line_id=? AND kind='work' AND end IS NULL", now, docId, lineId);
}
export function stopOrderTimers(docId, now = localDateTime()) {
  run("UPDATE time_entries SET end=? WHERE document_id=? AND kind='work' AND end IS NULL", now, docId);
}

/** Ce sur quoi un mécanicien travaille en ce moment : OR, intervention, temps passé / prévu. */
export function currentWork(userId, now = localDateTime()) {
  const e = get(`SELECT t.document_id, t.line_id, t.start, d.number, v.plate FROM time_entries t
    LEFT JOIN documents d ON d.id=t.document_id LEFT JOIN vehicles v ON v.id=d.vehicle_id
    WHERE t.user_id=? AND t.kind='work' AND t.end IS NULL ORDER BY t.start DESC LIMIT 1`, userId);
  if (!e || !e.document_id) return null;
  const wt = orderTimes(e.document_id, null, now);
  const slot = wt.byLine.get(e.line_id) || null;
  const line = slot ? get('SELECT description FROM document_lines WHERE id=?', e.line_id) : null;
  // sans intervention précise, on compare au temps de tout l'OR
  const planned = slot ? slot.planned : wt.planned;
  const spent = slot ? slot.spent : wt.spent;
  return { document_id: e.document_id, number: e.number, plate: e.plate, line: line?.description || null, since: e.start,
    planned, spent: r4(spent), over: isOver(spent, planned) };
}

/**
 * Statistiques par mécanicien et liste des interventions sur une période.
 * - « heures sur OR » et « présence » : pointages commencés pendant la période ;
 * - prévu / passé / dépassements : interventions terminées (ou déjà en dépassement) dont le dernier pointage
 *   tombe dans la période — chaque intervention ne compte donc qu'une fois. À plusieurs sur la même intervention,
 *   le temps prévu est partagé au prorata du temps passé par chacun.
 */
export function workStats(from, to, now = localDateTime()) {
  const mechanics = all("SELECT id, name, color FROM users WHERE role='mechanic' AND active=1 ORDER BY name");
  const period = all('SELECT user_id, kind, document_id, start, end FROM time_entries WHERE substr(start,1,10) BETWEEN ? AND ?', from, to);
  const docIds = [...new Set(period.filter((e) => e.kind === 'work' && e.document_id).map((e) => e.document_id))];
  const units = [];
  for (const id of docIds) {
    const doc = get(`SELECT d.id, d.number, d.status, v.plate FROM documents d LEFT JOIN vehicles v ON v.id=d.vehicle_id WHERE d.id=? AND d.type='order'`, id);
    if (!doc) continue;
    const interventions = new Map(all(LINES_SQL, id).filter(isIntervention).map((l) => [l.id, l]));
    const closed = ['done', 'invoiced'].includes(doc.status);
    const map = new Map();
    const entries = all(`SELECT t.user_id, t.line_id, t.start, t.end, u.name AS user_name FROM time_entries t JOIN users u ON u.id=t.user_id
      WHERE t.document_id=? AND t.kind='work'`, id);
    for (const e of entries) {
      const line = interventions.get(e.line_id) || null;
      const key = line ? line.id : 0;
      let u = map.get(key);
      if (!u) {
        u = { document_id: doc.id, number: doc.number, plate: doc.plate, line_id: line ? line.id : null,
          description: line ? line.description : 'Travail sur l\'OR (sans intervention précise)',
          planned: null, spent: 0, active: 0, last: '', inPeriod: false, byUser: new Map(), names: new Map(),
          finished: line ? !!line.done || closed : closed };
        map.set(key, u);
      }
      const h = hoursOf(e, now);
      u.spent += h;
      u.byUser.set(e.user_id, (u.byUser.get(e.user_id) || 0) + h);
      u.names.set(e.user_id, e.user_name);
      if (!e.end) u.active++;
      if (e.start > u.last) u.last = e.start;
      const day = e.start.slice(0, 10);
      if (day >= from && day <= to) u.inPeriod = true;
    }
    for (const u of map.values()) {
      if (u.line_id) u.planned = plannedOf(interventions.get(u.line_id));
      else {
        // le temps pointé sur l'OR entier couvre les interventions qui n'ont pas leur propre chrono
        let p = 0;
        for (const l of interventions.values()) if (!map.has(l.id)) p += plannedOf(l) || 0;
        u.planned = p > 0 ? p : null;
      }
      u.over = isOver(u.spent, u.planned) ? u.spent - u.planned : 0;
      if (u.inPeriod) units.push(u);
    }
  }
  const sum = (list) => list.reduce((s, e) => s + hoursOf(e, now), 0);
  const stats = mechanics.map((m) => {
    const mine = period.filter((e) => e.user_id === m.id);
    const work = sum(mine.filter((e) => e.kind === 'work'));
    const presence = sum(mine.filter((e) => e.kind === 'presence'));
    let planned = 0, spent = 0, interventions = 0, overruns = 0;
    for (const u of units) {
      const h = u.byUser.get(m.id);
      if (!h) continue;
      const lastDay = u.last.slice(0, 10);
      if (lastDay < from || lastDay > to) continue;
      if (!u.planned || !(u.finished || u.over)) continue;
      planned += u.planned * (h / u.spent);
      spent += h;
      interventions++;
      if (u.over) overruns++;
    }
    return { ...m, work: round2(work), presence: round2(presence), productivity: presence ? Math.round((work / presence) * 100) : null,
      interventions, planned: round2(planned), spent: round2(spent), gap: round2(spent - planned),
      efficiency: spent > 0 ? Math.round((planned / spent) * 100) : null, overruns, current: currentWork(m.id, now) };
  });
  const list = units
    .sort((a, b) => (b.over > 0) - (a.over > 0) || b.over - a.over || (b.last < a.last ? -1 : 1))
    .map((u) => ({ document_id: u.document_id, number: u.number, plate: u.plate, line_id: u.line_id, description: u.description,
      mechanics: [...u.names.values()].join(', '), planned: u.planned ? round2(u.planned) : null, spent: round2(u.spent),
      over: round2(u.over), finished: u.finished, active: u.active, last: u.last }));
  return { from, to, mechanics: stats, interventions: list };
}
