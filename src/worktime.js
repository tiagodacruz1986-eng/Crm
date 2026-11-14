// Temps atelier : temps prévu et temps passé sur chaque intervention d'un ordre de réparation,
// dépassements, et statistiques par mécanicien (tableau de bord, feuilles de temps).
import { db, all, get, run, round2, localDateTime } from './db.js';

// Temps prévu par le gérant pour une intervention (en heures). Vide = heures vendues de la ligne de main-d'œuvre.
if (!all('PRAGMA table_info(document_lines)').some((c) => c.name === 'planned_hours')) db.exec('ALTER TABLE document_lines ADD COLUMN planned_hours REAL');
db.exec('CREATE INDEX IF NOT EXISTS idx_time_document ON time_entries(document_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_lines_document ON document_lines(document_id)');

/** Une intervention = une ligne de main-d'œuvre ou un forfait (ni une pièce, ni un commentaire). */
export const isIntervention = (l) => !!l && (l.kind === 'labor' || l.kind === 'fee');

// 30 secondes de marge : un chrono arrêté pile à l'heure prévue n'est pas un dépassement
const TOLERANCE = 1 / 120;
export const isOver = (spent, planned) => planned > 0 && spent - planned > TOLERANCE;
const r4 = (n) => Math.round((Number(n) || 0) * 1e4) / 1e4;
const hoursOf = (t, now) => Math.max(0, (new Date(t.end || now) - new Date(t.start)) / 3600000);
// Chrono oublié, arrêté automatiquement à la fin de la journée : sa durée est une estimation, à vérifier par le gérant
const isAuto = (e) => e.source === 'auto';

/**
 * Temps prévu d'une intervention : celui saisi par le gérant ; sinon, pour la main-d'œuvre, les heures vendues.
 * Forfait laissé vide, ou 0 : pas de temps prévu (cette intervention ne passe jamais en rouge).
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
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    v = v.trim().replace(',', '.');
    if (v === '') return null;
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(v)) return undefined; // invalide : à refuser par l'appelant
  } else if (typeof v !== 'number') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 999) return undefined;
  return Math.round(n * 100) / 100;
}

const LINES_SQL = 'SELECT id, kind, description, quantity, planned_hours, done FROM document_lines WHERE document_id=? ORDER BY sequence, id';

/**
 * Temps d'un OR : par intervention (chronos démarrés sur la ligne) et au total.
 * - « general » : temps pointé sur l'OR sans intervention précise ;
 * - « unplanned » : temps pointé sur des interventions sans temps prévu — il n'est jamais comparé au temps prévu ;
 * - « comparable » : le reste, que l'on compare au temps prévu de l'OR (« over » = dépassement de l'OR).
 */
export function orderTimes(docId, lines = null, now = localDateTime()) {
  const rows = lines || all(LINES_SQL, docId);
  const entries = all(`SELECT t.id, t.user_id, t.line_id, t.start, t.end, t.note, t.source, u.name AS user_name FROM time_entries t JOIN users u ON u.id=t.user_id
    WHERE t.document_id=? AND t.kind='work' ORDER BY t.start, t.id`, docId);
  const byLine = new Map(rows.filter(isIntervention).map((l) => [l.id, { planned: plannedOf(l), spent: 0, active: 0, workers: [], auto: false }]));
  const general = { spent: 0, active: 0, workers: [], auto: false };
  let spent = 0, active = 0, unplanned = 0;
  for (const e of entries) {
    const h = hoursOf(e, now);
    const slot = byLine.get(e.line_id) || general;
    e.hours = r4(h);
    e.on_line = slot !== general;
    e.auto = isAuto(e);
    slot.spent += h; spent += h;
    if (e.auto) slot.auto = true;
    if (slot !== general && !slot.planned) unplanned += h;
    if (!e.end) { slot.active++; active++; if (!slot.workers.includes(e.user_name)) slot.workers.push(e.user_name); }
  }
  let planned = 0;
  for (const s of byLine.values()) planned += s.planned || 0;
  const comparable = spent - unplanned;
  return { byLine, general, spent, active, unplanned, comparable, planned: planned > 0 ? r4(planned) : null, over: isOver(comparable, planned), entries };
}

/** Ajoute à un OR chargé (getDocument) le temps prévu / passé de chaque intervention et les totaux. */
export function attachTimes(d, now = localDateTime()) {
  const wt = orderTimes(d.id, d.lines, now);
  const names = new Map(d.lines.map((l) => [l.id, l.description]));
  for (const l of d.lines) {
    const s = wt.byLine.get(l.id);
    if (s) Object.assign(l, { planned: s.planned, spent: r4(s.spent), active: s.active, workers: s.workers, auto: s.auto });
  }
  d.time_entries = wt.entries.map((e) => ({ ...e, line_description: e.on_line ? names.get(e.line_id) || null : null }));
  d.hours_spent = r4(wt.spent);
  d.hours_planned = wt.planned;
  d.hours_unplanned = r4(wt.unplanned);
  d.hours_general = r4(wt.general.spent);
  d.general_active = wt.general.active;
  d.general_workers = wt.general.workers;
  d.general_auto = wt.general.auto;
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
    hours_spent: r4(wt.spent), hours_planned: wt.planned, hours_unplanned: r4(wt.unplanned), hours_general: r4(wt.general.spent),
    general_active: wt.general.active, general_workers: wt.general.workers, active: wt.active,
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
  // sans intervention précise, on compare au temps prévu de tout l'OR (hors interventions sans temps prévu)
  const planned = slot ? slot.planned : wt.planned;
  const spent = slot ? slot.spent : wt.comparable;
  return { document_id: e.document_id, number: e.number, plate: e.plate, line: line?.description || null, since: e.start,
    planned, spent: r4(spent), over: isOver(spent, planned) };
}

const inRange = (start, from, to) => { const day = String(start || '').slice(0, 10); return day >= from && day <= to; };

/**
 * Statistiques par mécanicien et liste des interventions sur une période.
 *
 * Ce que l'on juge (« unité ») :
 * - chaque intervention sur laquelle un chrono a été démarré : son temps passé contre son temps prévu ;
 * - le temps pointé sur l'OR sans intervention précise (« autre travail », vieille habitude) : contre ce qui RESTE du temps
 *   prévu de l'OR, c'est-à-dire le total prévu moins ce que les interventions chronométrées ont déjà consommé. Dans ce cas,
 *   une intervention finie plus vite que prévu ne donne pas de « gain » (le reste de son temps prévu passe dans ce pot commun,
 *   puisqu'on ne sait pas à quoi le temps général a servi) ; un dépassement sur une intervention reste un dépassement.
 *   La somme des écarts d'un OR est ainsi toujours égale à (temps passé − temps prévu) de l'OR.
 *
 * Règles :
 * - « heures sur OR » et « présence » : pointages commencés pendant la période ;
 * - prévu / passé / écart : interventions avec un temps prévu, terminées (ou déjà en dépassement). Chaque mécanicien la compte
 *   une seule fois, dans la période de SON dernier pointage dessus, pour toute la durée de l'intervention ;
 * - à plusieurs sur la même intervention, le temps prévu est partagé au prorata du temps de chacun, et le « dépassement »
 *   est compté à celui (ou ceux) qui y a passé le plus de temps (au moins la moitié, sinon la plus grande part) ;
 * - une intervention sans temps prévu n'est jamais jugée ; une intervention dont un chrono a été arrêté automatiquement
 *   (oubli) non plus : elle est « à vérifier ».
 */
export function workStats(from, to, now = localDateTime()) {
  const period = all('SELECT user_id, kind, document_id, start, end FROM time_entries WHERE substr(start,1,10) BETWEEN ? AND ?', from, to);
  // mécaniciens actifs, plus toute personne ayant pointé du travail sur la période (mécanicien désactivé depuis, bureau venu aider)
  const workers = new Set(period.filter((e) => e.kind === 'work').map((e) => e.user_id));
  const mechanics = all('SELECT id, name, color, role, active FROM users ORDER BY name').filter((u) => (u.role === 'mechanic' && u.active) || workers.has(u.id));
  const docIds = [...new Set(period.filter((e) => e.kind === 'work' && e.document_id).map((e) => e.document_id))];
  const units = [];
  for (const id of docIds) {
    const doc = get(`SELECT d.id, d.number, d.status, v.plate FROM documents d LEFT JOIN vehicles v ON v.id=d.vehicle_id WHERE d.id=? AND d.type='order'`, id);
    if (!doc) continue;
    const interventions = new Map(all(LINES_SQL, id).filter(isIntervention).map((l) => [l.id, l]));
    const closed = ['done', 'invoiced'].includes(doc.status);
    const entries = all(`SELECT t.user_id, t.line_id, t.start, t.end, t.source, u.name AS user_name FROM time_entries t JOIN users u ON u.id=t.user_id
      WHERE t.document_id=? AND t.kind='work'`, id);
    const map = new Map();
    for (const e of entries) {
      const line = interventions.get(e.line_id) || null;
      const key = line ? line.id : 0;
      let u = map.get(key);
      if (!u) {
        u = { document_id: doc.id, number: doc.number, plate: doc.plate, line_id: line ? line.id : null, whole: !line, description: line ? line.description : '',
          planned: null, judged: false, spent: 0, period_spent: 0, active: 0, auto: false, byUser: new Map(), lastBy: new Map(), names: new Map(), finished: false };
        map.set(key, u);
      }
      const h = hoursOf(e, now);
      u.spent += h;
      if (inRange(e.start, from, to)) u.period_spent += h;
      u.byUser.set(e.user_id, (u.byUser.get(e.user_id) || 0) + h);
      u.names.set(e.user_id, e.user_name);
      if (!e.end) u.active++;
      if (isAuto(e)) u.auto = true;
      if (e.start > (u.lastBy.get(e.user_id) || '')) u.lastBy.set(e.user_id, e.start);
    }
    const general = map.get(0) || null;
    let consumed = 0; // temps prévu déjà « utilisé » par les interventions chronométrées
    for (const u of map.values()) {
      if (u.whole) continue;
      const l = interventions.get(u.line_id);
      const p = plannedOf(l);
      u.finished = !!l.done || closed;
      if (!p) continue; // pas de temps prévu : jamais jugée
      consumed += Math.min(p, u.spent);
      // avec du temps « général » sur l'OR, une intervention finie en avance ne crée pas de gain : le reste va au pot commun
      u.planned = general && u.finished && u.spent < p ? u.spent : p;
      u.judged = true;
    }
    if (general) {
      let total = 0;
      for (const l of interventions.values()) total += plannedOf(l) || 0;
      general.description = map.size > 1 ? 'Autre travail sur l\'OR (comparé au reste du temps prévu)' : 'OR entier (temps pointé sans intervention précise)';
      general.finished = closed || (interventions.size > 0 && [...interventions.values()].every((l) => l.done));
      if (total > 0) { general.planned = Math.max(0, total - consumed); general.judged = true; }
    }
    for (const u of map.values()) {
      u.over = u.judged && u.spent - u.planned > TOLERANCE ? u.spent - u.planned : 0;
      // celui (ou ceux) qui porte le dépassement : au moins la moitié du temps, sinon la plus grande part
      const top = Math.max(...u.byUser.values());
      u.main = new Set([...u.byUser].filter(([, h]) => u.spent > 0 && (h / u.spent >= 0.5 || h >= top - 1e-9)).map(([uid]) => uid));
      // comptée (et listée) dans la période où quelqu'un y a fait son dernier pointage
      if ([...u.lastBy.values()].some((s) => inRange(s, from, to))) units.push(u);
    }
  }
  const sum = (list) => list.reduce((s, e) => s + hoursOf(e, now), 0);
  const stats = mechanics.map((m) => {
    const mine = period.filter((e) => e.user_id === m.id);
    const work = sum(mine.filter((e) => e.kind === 'work'));
    const presence = sum(mine.filter((e) => e.kind === 'presence'));
    let planned = 0, spent = 0, interventions = 0, overruns = 0, toCheck = 0;
    for (const u of units) {
      const h = u.byUser.get(m.id);
      if (!h || !inRange(u.lastBy.get(m.id), from, to)) continue;
      if (!u.judged || !(u.finished || u.over)) continue;
      if (u.auto) { toCheck++; continue; }
      planned += u.planned * (h / u.spent);
      spent += h;
      interventions++;
      if (u.over && u.main.has(m.id)) overruns++;
    }
    return { id: m.id, name: m.name, color: m.color, inactive: !m.active, work: round2(work), presence: round2(presence),
      productivity: presence ? Math.round((work / presence) * 100) : null,
      interventions, planned: round2(planned), spent: round2(spent), gap: round2(spent - planned),
      efficiency: spent > 0 ? Math.round((planned / spent) * 100) : null, overruns, to_check: toCheck, current: currentWork(m.id, now) };
  });
  const last = (u) => [...u.lastBy.values()].sort().pop() || '';
  const list = units
    .map((u) => ({ u, last: last(u) }))
    .sort((a, b) => (b.u.over > 0) - (a.u.over > 0) || b.u.over - a.u.over || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
    .map(({ u, last: at }) => ({ document_id: u.document_id, number: u.number, plate: u.plate, line_id: u.line_id, whole: u.whole, description: u.description,
      mechanics: [...u.names.values()].join(', '), shared: u.byUser.size > 1, planned: u.judged ? round2(u.planned) : null,
      spent: round2(u.spent), period_spent: round2(u.period_spent), over: round2(u.over), finished: u.finished, active: u.active, auto: u.auto, last: at }));
  return { from, to, mechanics: stats, interventions: list };
}
