// Rapports mensuels de l'atelier : chaque mécanicien reçoit son propre rapport par e-mail,
// le gérant reçoit celui de toute l'équipe. Les mêmes chiffres se consultent et s'impriment dans « Feuilles de temps → Rapport du mois ».
import { db, all, get, run, getSettings, today, localDate, localDateTime, round2 } from './db.js';
import { workStats } from './worktime.js';
import { attendanceReport } from './attendance.js';
import { sendReportEmail, isMailConfigured, createActivity } from './mail.js';
import { BusinessError } from './business.js';

db.exec(`
CREATE TABLE IF NOT EXISTS report_runs (
  id INTEGER PRIMARY KEY, month TEXT NOT NULL, kind TEXT NOT NULL, user_id INTEGER, to_addr TEXT, status TEXT NOT NULL,
  error TEXT, auto INTEGER DEFAULT 0, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_report_runs ON report_runs(month, kind, user_id);`);

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** 1.5 → « 1h30 » */
export const hm = (h) => { const m = Math.round((Number(h) || 0) * 60); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };
/** Écart entre temps passé et temps prévu : « + 0h30 » (plus long que prévu) ou « − 0h15 » (plus court). */
export const gapText = (g) => (Math.abs(g) < 0.005 ? '0h00' : `${g > 0 ? '+' : '−'} ${hm(Math.abs(g))}`);
const fdate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('fr-LU') : '');

/** Mois « AAAA-MM » : premier et dernier jour (le mois en cours s'arrête à aujourd'hui), libellé « octobre 2026 ». */
export function monthBounds(ym) {
  if (typeof ym !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new BusinessError('Mois invalide (attendu : AAAA-MM)');
  const [y, m] = ym.split('-').map(Number);
  const from = `${ym}-01`;
  let to = localDate(new Date(y, m, 0, 12)); // dernier jour du mois
  const t = today();
  if (from > t) throw new BusinessError('Ce mois n\'a pas encore commencé');
  if (to > t) to = t;
  const label = new Date(y, m - 1, 15).toLocaleDateString('fr-LU', { month: 'long', year: 'numeric' });
  return { month: ym, from, to, label, complete: to < t };
}
/** Mois précédent (« 2026-10 » le 1er novembre). */
export function previousMonth(d = new Date()) {
  const p = new Date(d.getFullYear(), d.getMonth() - 1, 15);
  return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Données du rapport d'un mois : une fiche par mécanicien (résumé + ses interventions) et les totaux de l'équipe.
 * Les chiffres suivent exactement les règles des statistiques du tableau de bord (voir worktime.js → workStats).
 */
export function monthlyReport(ym) {
  const b = monthBounds(ym);
  const stats = workStats(b.from, b.to);
  const att = new Map(attendanceReport({ from: b.from, to: b.to }).map((r) => [r.user_id, r]));
  // jours travaillés d'après les pointages eux-mêmes : un mécanicien désactivé en cours de mois garde ses jours
  const worked = new Map(all("SELECT user_id, COUNT(DISTINCT substr(start, 1, 10)) AS n FROM time_entries WHERE kind='presence' AND substr(start, 1, 10) BETWEEN ? AND ? GROUP BY user_id", b.from, b.to).map((r) => [r.user_id, r.n]));
  const inPeriod = (s) => { const day = String(s || '').slice(0, 10); return day >= b.from && day <= b.to; };
  const mechanics = stats.mechanics.map((m) => {
    const a = att.get(m.id);
    // ses interventions du mois : celles où son dernier pointage tombe dans le mois (même règle que les statistiques)
    const rows = stats.interventions.map((u) => {
      const me = (u.people || []).find((p) => p.id === m.id);
      if (!me || !inPeriod(me.last)) return null;
      const share = u.credit !== null && u.spent > 0 ? round2(u.credit * (me.hours / u.spent)) : null;
      const state = u.auto ? 'check' : u.planned === null ? 'unplanned' : !(u.finished || u.over > 0) ? 'open' : u.over > 0 ? 'over' : 'ok';
      return { date: me.last.slice(0, 10), document_id: u.document_id, number: u.number, plate: u.plate, description: u.description,
        // l'écart n'est donné que pour une intervention jugée (terminée ou déjà en dépassement) : ni en cours, ni chrono oublié
        planned: share, spent: me.hours, gap: share === null || !['over', 'ok'].includes(state) ? null : round2(me.hours - share), state,
        mine: (u.main || []).includes(m.id), with: (u.people || []).filter((p) => p.id !== m.id).map((p) => p.name).join(', ') };
    }).filter(Boolean).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    return { id: m.id, name: m.name, color: m.color, inactive: m.inactive,
      days: a ? a.days : worked.get(m.id) || 0, late: a ? a.late : 0, presence: m.presence, work: m.work, productivity: m.productivity,
      interventions: m.interventions, planned: m.planned, spent: m.spent, gap: m.gap, overruns: m.overruns, to_check: rows.filter((r) => r.state === 'check').length, rows };
  }).filter((m) => !m.inactive || m.work > 0 || m.presence > 0);
  const sum = (k) => round2(mechanics.reduce((s, m) => s + (Number(m[k]) || 0), 0));
  const totals = { presence: sum('presence'), work: sum('work'), interventions: sum('interventions'), planned: sum('planned'), spent: sum('spent'),
    gap: round2(sum('spent') - sum('planned')) };
  totals.productivity = totals.presence ? Math.round((totals.work / totals.presence) * 100) : null;
  const overruns = stats.interventions.filter((u) => u.over > 0 && !u.auto);
  const toCheck = stats.interventions.filter((u) => u.auto);
  // totaux de l'équipe = les listes affichées dessous (une intervention faite à deux ne compte qu'une fois)
  totals.overruns = overruns.length; totals.to_check = toCheck.length;
  return { ...b, mechanics, totals, overruns, to_check: toCheck };
}

// ---------- Mise en page pour l'e-mail (tableaux simples, lisibles dans toutes les messageries) ----------
const TH = 'padding:5px 6px;background:#f3f4f6;font-size:11px;text-align:left;border-bottom:1px solid #ddd';
const TD = 'padding:5px 6px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top';
const NUM = ';text-align:right;white-space:nowrap';
const RED = 'color:#c81e1e;font-weight:bold';
const GREEN = 'color:#047857;font-weight:bold';
function htmlTable(head, rows, nums = []) {
  const th = head.map((h, i) => `<th style="${TH}${nums.includes(i) ? NUM : ''}">${h}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td style="${TD}${nums.includes(i) ? NUM : ''}">${c}</td>`).join('')}</tr>`).join('');
  return `<table style="width:100%;border-collapse:collapse;margin:10px 0 16px">${head.length ? `<tr>${th}</tr>` : ''}${tr}</table>`;
}
const gapHtml = (g) => (g === null || g === undefined ? '—' : `<span style="${g > 0.005 ? RED : GREEN}">${gapText(g)}</span>`);
const STATE = { over: `<span style="${RED}">dépassé</span>`, ok: 'dans le temps', open: 'en cours', unplanned: 'sans temps prévu', check: '<span style="color:#b45309">à vérifier</span>' };
const NOTE = '<div style="font-size:11px;color:#777;line-height:1.5">« Prévu » : temps prévu par le garage pour l\'intervention. « Passé » : temps pointé à la tablette. '
  + 'À plusieurs sur une intervention, le temps prévu est partagé selon le temps de chacun. Une intervention est comptée le mois du dernier pointage dessus. '
  + '« À vérifier » : chrono oublié, arrêté automatiquement — sa durée n\'est pas comptée tant qu\'elle n\'a pas été corrigée.</div>';

/** Rapport personnel d'un mécanicien (bloc HTML placé dans l'e-mail). */
export function mechanicHtml(rep, m) {
  const summary = [
    ['Jours travaillés', esc(m.days)],
    ['Heures de présence', hm(m.presence)],
    ['Heures sur des ordres de réparation', `${hm(m.work)}${m.productivity !== null ? ` <span style="color:#777">(${m.productivity} % du temps de présence)</span>` : ''}`],
    ['Interventions terminées (avec un temps prévu)', esc(m.interventions)],
    ['Temps prévu', m.interventions ? hm(m.planned) : '—'],
    ['Temps passé', m.interventions ? hm(m.spent) : '—'],
    ['Écart', m.interventions ? gapHtml(m.gap) : '—'],
    ['Dépassements du temps prévu', m.overruns ? `<span style="${RED}">${esc(m.overruns)}</span>` : '0'],
  ];
  if (m.to_check) summary.push(['Interventions à vérifier (chrono oublié)', esc(m.to_check)]);
  let html = `<h3 style="margin:18px 0 4px">Rapport d'activité — ${esc(rep.label)}</h3><div style="color:#555;font-size:13px">${esc(m.name)} · du ${fdate(rep.from)} au ${fdate(rep.to)}</div>`;
  html += htmlTable([], summary, [1]);
  if (m.rows.length) {
    html += '<h4 style="margin:14px 0 2px">Vos interventions</h4>';
    // 4 colonnes seulement : le rapport se lit sur un téléphone
    const small = (s) => `<br><span style="color:#777;font-size:11px">${s}</span>`;
    html += htmlTable(['Intervention', 'Prévu', 'Passé', 'Écart'], m.rows.map((r) => [
      `${esc(r.description)}${small(`${fdate(r.date)} · ${esc(r.number || '')}${r.plate ? ` · ${esc(r.plate)}` : ''}${r.with ? ` · avec ${esc(r.with)}` : ''}`)}`,
      r.planned === null ? '—' : hm(r.planned), hm(r.spent), `${gapHtml(r.gap)}${STATE[r.state] ? small(STATE[r.state]) : ''}`,
    ]), [1, 2, 3]);
  } else html += '<p style="font-size:13px;color:#555">Aucune intervention chronométrée ce mois-ci.</p>';
  return html + NOTE;
}

/** Rapport de toute l'équipe (bloc HTML placé dans l'e-mail du gérant). */
export function teamHtml(rep, delivery = null) {
  let html = `<h3 style="margin:18px 0 4px">Rapport de l'atelier — ${esc(rep.label)}</h3><div style="color:#555;font-size:13px">Du ${fdate(rep.from)} au ${fdate(rep.to)}</div>`;
  const row = (m, bold = false) => {
    const w = (v) => (bold ? `<b>${v}</b>` : v);
    const sub = (s) => (s ? `<br><span style="color:#777;font-size:11px;font-weight:normal">${s}</span>` : '');
    // 6 colonnes (au lieu de 9) : le tableau tient sur l'écran d'un téléphone
    return [w(esc(m.name)) + sub(m.inactive ? 'inactif' : ''),
      w(hm(m.presence)) + sub(m.days !== '' && m.days !== undefined ? `${esc(m.days)} j` : ''),
      w(hm(m.work)) + sub(m.productivity !== null && m.productivity !== undefined ? `${m.productivity} %` : ''),
      w(m.interventions ? hm(m.planned) : '—') + sub(`${esc(m.interventions)} interv.`), w(m.interventions ? hm(m.spent) : '—'),
      (m.interventions ? gapHtml(m.gap) : '—') + sub(m.overruns ? `<span style="${RED}">${esc(m.overruns)} dépass.</span>` : '')];
  };
  html += htmlTable(['Mécanicien', 'Présence', 'Sur OR', 'Prévu', 'Passé', 'Écart'],
    [...rep.mechanics.map((m) => row(m)), row({ name: 'Total équipe', days: '', ...rep.totals }, true)], [1, 2, 3, 4, 5]);
  if (rep.overruns.length) {
    html += '<h4 style="margin:14px 0 2px">Interventions en dépassement</h4>';
    html += htmlTable(['Intervention', 'Prévu', 'Passé', 'Écart'], rep.overruns.map((u) => [
      `${esc(u.description)}<br><span style="color:#777;font-size:11px">${esc(u.number || '')}${u.plate ? ` · ${esc(u.plate)}` : ''} · ${esc(u.mechanics)}</span>`,
      hm(u.planned), hm(u.spent), gapHtml(u.over)]), [1, 2, 3]);
  } else html += '<p style="font-size:13px;color:#047857">Aucune intervention en dépassement ce mois-ci.</p>';
  if (rep.to_check.length) {
    html += '<h4 style="margin:14px 0 2px">À vérifier (chrono oublié, arrêté automatiquement)</h4>';
    html += htmlTable(['Intervention', 'Durée enregistrée'], rep.to_check.map((u) => [`${esc(u.description)}<br><span style="color:#777;font-size:11px">${esc(u.number || '')} · ${esc(u.mechanics)}</span>`, hm(u.spent)]), [1]);
    html += '<p style="font-size:12px;color:#555">Corrigez leurs heures dans « Feuilles de temps » : elles seront alors comptées normalement.</p>';
  }
  if (delivery) {
    const sent = delivery.filter((d) => d.status === 'sent').map((d) => esc(d.name));
    const none = delivery.filter((d) => d.status === 'no_email').map((d) => esc(d.name));
    const failed = delivery.filter((d) => d.status === 'error').map((d) => esc(d.name));
    html += '<h4 style="margin:14px 0 2px">Rapports individuels</h4><div style="font-size:13px;line-height:1.6">';
    html += sent.length ? `Envoyé à : ${sent.join(', ')}.<br>` : '';
    html += none.length ? `Pas d'adresse e-mail (Paramètres → Utilisateurs) : ${none.join(', ')}.<br>` : '';
    html += failed.length ? `<span style="${RED}">Envoi en échec : ${failed.join(', ')}.</span><br>` : '';
    html += '</div>';
  }
  return html + NOTE;
}

const garageName = () => getSettings().company?.name || 'Garage';
const validEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

/** Destinataires du rapport d'équipe : les administrateurs actifs qui ont une adresse, plus l'adresse indiquée dans la configuration. */
export function teamRecipients(extra = '') {
  const list = all("SELECT id, name, email FROM users WHERE role='admin' AND active=1 ORDER BY id").filter((u) => validEmail(u.email)).map((u) => ({ id: u.id, name: u.name, email: u.email.trim() }));
  for (const e of String(extra || '').split(/[;,\s]+/).filter(validEmail)) if (!list.some((r) => r.email.toLowerCase() === e.toLowerCase())) list.push({ id: null, name: e, email: e });
  return list;
}

/** Qui recevra quoi pour un mois donné, et ce qui a déjà été envoyé (affiché avant l'envoi). */
export function reportPlan(ym, extra = '') {
  const rep = monthlyReport(ym);
  const runs = all('SELECT kind, user_id, to_addr, status, error, sent_at, auto FROM report_runs WHERE month=? ORDER BY id', ym);
  // « partial » : envoyé avant la fin du mois — le rapport complet repartira une fois le mois terminé
  const lastOf = (kind, userId, addr) => {
    const r = runs.filter((x) => x.kind === kind && (userId ? x.user_id === userId : x.to_addr === addr)).pop();
    return r ? { ...r, partial: r.status === 'sent' && !coversMonth(r.sent_at, ym) } : null;
  };
  const emails = new Map(all('SELECT id, email, active FROM users').map((u) => [u.id, u]));
  return {
    month: rep.month, label: rep.label, complete: rep.complete, mail_configured: isMailConfigured(),
    mechanics: rep.mechanics.map((m) => {
      const u = emails.get(m.id);
      return { id: m.id, name: m.name, email: validEmail(u?.email) ? u.email.trim() : null, active: !!u?.active, has_activity: m.work > 0 || m.presence > 0, last: lastOf('mechanic', m.id) };
    }),
    team: teamRecipients(extra).map((r) => ({ ...r, last: lastOf('team', r.id, r.email) })),
  };
}

/** Dernier jour du mois « AAAA-MM ». */
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return localDate(new Date(y, m, 0, 12)); };
/** Un envoi couvre tout le mois s'il a été fait après le dernier jour de ce mois. */
const coversMonth = (sentAt, ym) => String(sentAt || '').slice(0, 10) > monthEnd(ym);

const log = (month, kind, userId, to, status, error, auto) => run('INSERT INTO report_runs(month, kind, user_id, to_addr, status, error, auto, sent_at) VALUES(?,?,?,?,?,?,?,?)',
  month, kind, userId, to, status, error ? String(error).slice(0, 300) : null, auto ? 1 : 0, localDateTime());

/**
 * Envoie les rapports d'un mois : à chaque mécanicien actif qui a travaillé et possède une adresse → son rapport ;
 * aux administrateurs → le rapport de l'équipe. « only » limite l'envoi : { mechanic: id } ou { team: true }.
 * Sans « force », ce qui a déjà été envoyé avec succès pour ce mois n'est pas renvoyé. Un envoi fait AVANT la fin du mois
 * (rapport arrêté au jour de l'envoi) n'empêche pas le rapport complet de partir une fois le mois terminé.
 * Un seul envoi à la fois par mois : deux demandes simultanées n'envoient pas chaque rapport deux fois.
 */
const sending = new Set();
export async function sendMonthlyReports(ym, opts = {}) {
  if (!isMailConfigured()) throw new BusinessError('L\'envoi d\'e-mails n\'est pas configuré (Paramètres → E-mails) : aucun rapport n\'a été envoyé.');
  monthBounds(ym); // mois valide et commencé : vérifié avant de prendre le verrou
  if (sending.has(ym)) throw new BusinessError('Un envoi des rapports de ce mois est déjà en cours. Patientez un instant.');
  sending.add(ym);
  try { return await deliverReports(ym, opts); } finally { sending.delete(ym); }
}
async function deliverReports(ym, { force = false, auto = false, only = null, extra = '', userId = null } = {}) {
  const rep = monthlyReport(ym);
  const already = (kind, uid, addr) => !force && all(`SELECT sent_at FROM report_runs WHERE month=? AND kind=? AND status='sent' AND ${uid ? 'user_id=?' : 'to_addr=?'}`, ym, kind, uid || addr)
    .some((r) => !rep.complete || coversMonth(r.sent_at, ym));
  const delivery = [];
  if (!only || only.mechanic) {
    for (const m of rep.mechanics) {
      if (only?.mechanic && Number(only.mechanic) !== m.id) continue;
      const u = get('SELECT email, active FROM users WHERE id=?', m.id);
      if (!u?.active || !(m.work > 0 || m.presence > 0)) { if (only?.mechanic) delivery.push({ kind: 'mechanic', id: m.id, name: m.name, status: 'nothing' }); continue; }
      if (!validEmail(u.email)) { delivery.push({ kind: 'mechanic', id: m.id, name: m.name, status: 'no_email' }); continue; }
      const to = u.email.trim();
      if (already('mechanic', m.id)) { delivery.push({ kind: 'mechanic', id: m.id, name: m.name, to, status: 'already' }); continue; }
      try {
        await sendReportEmail({ to, user_id: m.id, sender_id: userId, subject: `Votre rapport d'activité — ${rep.label}`,
          intro: `Bonjour ${m.name.split(' ')[0]},\n\nVoici votre rapport d'activité à l'atelier pour ${rep.label}.`, html: mechanicHtml(rep, m) });
        log(ym, 'mechanic', m.id, to, 'sent', null, auto);
        delivery.push({ kind: 'mechanic', id: m.id, name: m.name, to, status: 'sent' });
      } catch (e) {
        log(ym, 'mechanic', m.id, to, 'error', e.message, auto);
        delivery.push({ kind: 'mechanic', id: m.id, name: m.name, to, status: 'error', error: e.message });
      }
    }
  }
  if (!only || only.team) {
    const individual = delivery.filter((d) => d.kind === 'mechanic');
    for (const r of teamRecipients(extra)) {
      if (already('team', r.id, r.email)) { delivery.push({ kind: 'team', name: r.name, to: r.email, status: 'already' }); continue; }
      try {
        await sendReportEmail({ to: r.email, user_id: r.id, sender_id: userId, subject: `Rapport de l'atelier — ${rep.label} — ${garageName()}`,
          intro: `Bonjour,\n\nVoici le rapport de toute l'équipe de l'atelier pour ${rep.label}.`, html: teamHtml(rep, only ? null : individual) });
        log(ym, 'team', r.id, r.email, 'sent', null, auto);
        delivery.push({ kind: 'team', name: r.name, to: r.email, status: 'sent' });
      } catch (e) {
        log(ym, 'team', r.id, r.email, 'error', e.message, auto);
        delivery.push({ kind: 'team', name: r.name, to: r.email, status: 'error', error: e.message });
      }
    }
  }
  return { month: ym, label: rep.label, delivery, sent: delivery.filter((d) => d.status === 'sent').length, failed: delivery.filter((d) => d.status === 'error').length };
}

/**
 * Envoi automatique de fin de mois : le 1er du mois suivant (ou les jours d'après si l'ordinateur était éteint, jusqu'au 10),
 * à l'heure choisie. Renvoie null si rien n'était à faire.
 * Si un envoi échoue (messagerie injoignable, pas d'internet), un nouvel essai a lieu une heure plus tard, jusqu'au 10 :
 * ce qui est déjà parti ne repart pas. Le premier échec crée une tâche pour les administrateurs.
 */
const RETRY_MIN = 60;
let running = false;
export async function runMonthlyReports(opts, now = new Date()) {
  if (!opts?.monthly_report || running) return null;
  if (now.getDate() > 10 || now.toTimeString().slice(0, 5) < (opts.monthly_report_time || '07:00')) return null;
  const ym = previousMonth(now);
  const marker = get("SELECT id, status, sent_at FROM report_runs WHERE month=? AND kind='auto'", ym);
  if (marker?.status === 'done') return null;
  // essai précédent en échec, ou interrompu (logiciel arrêté pendant l'envoi) : on attend une heure avant de réessayer
  if (marker && (now - new Date(marker.sent_at)) / 60000 < RETRY_MIN) return null;
  if (!isMailConfigured()) return null; // on réessaiera : rien n'est marqué comme envoyé
  running = true;
  const stamp = localDateTime(now);
  try {
    // marqué d'abord : pendant l'envoi (et l'heure qui suit), aucun autre essai ne démarre
    if (marker) run("UPDATE report_runs SET status='started', error=NULL, sent_at=? WHERE id=?", stamp, marker.id);
    else run("INSERT INTO report_runs(month, kind, status, auto, sent_at) VALUES(?, 'auto', 'started', 1, ?)", ym, stamp);
    const r = await sendMonthlyReports(ym, { auto: true, extra: opts.report_to });
    run("UPDATE report_runs SET status=?, error=? WHERE month=? AND kind='auto'", r.failed ? 'partial' : 'done', r.failed ? `${r.failed} envoi(s) en échec` : null, ym);
    if (r.failed && !marker) warnAdmins(r.label, `${r.failed} envoi(s) en échec`);
    return r;
  } catch (e) {
    run("UPDATE report_runs SET status='error', error=? WHERE month=? AND kind='auto'", String(e.message).slice(0, 300), ym);
    if (!marker) warnAdmins(ym, e.message);
    throw e;
  } finally { running = false; }
}
/** Prévient les administrateurs (une tâche « à faire ») quand l'envoi automatique n'a pas abouti. */
function warnAdmins(label, reason) {
  try {
    for (const a of all("SELECT id FROM users WHERE role='admin' AND active=1")) {
      createActivity({ type: 'todo', module: 'general', user_id: a.id, due_date: today(),
        summary: `Rapports mensuels (${label}) : ${String(reason).slice(0, 120)}. Un nouvel essai a lieu chaque heure ; voir Feuilles de temps → Rapport du mois.`.slice(0, 250) }, a.id);
    }
  } catch (e) { console.error('Rapports mensuels : avertissement impossible', e.message); }
}
