// Rapports mensuels de l'atelier : chaque mécanicien reçoit son propre rapport par e-mail,
// le gérant reçoit celui de toute l'équipe. Les mêmes chiffres se consultent et s'impriment dans « Feuilles de temps → Rapport du mois ».
import { db, all, get, run, getSettings, today, localDate, localDateTime, round2 } from './db.js';
import { workStats } from './worktime.js';
import { attendanceReport } from './attendance.js';
import { sendReportEmail, isMailConfigured } from './mail.js';
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
  const inPeriod = (s) => { const day = String(s || '').slice(0, 10); return day >= b.from && day <= b.to; };
  const mechanics = stats.mechanics.map((m) => {
    const a = att.get(m.id);
    // ses interventions du mois : celles où son dernier pointage tombe dans le mois (même règle que les statistiques)
    const rows = stats.interventions.map((u) => {
      const me = (u.people || []).find((p) => p.id === m.id);
      if (!me || !inPeriod(me.last)) return null;
      const share = u.planned !== null && u.spent > 0 ? round2(u.planned * (me.hours / u.spent)) : null;
      const state = u.auto ? 'check' : u.planned === null ? 'unplanned' : !(u.finished || u.over > 0) ? 'open' : u.over > 0 ? 'over' : 'ok';
      return { date: me.last.slice(0, 10), document_id: u.document_id, number: u.number, plate: u.plate, description: u.description,
        planned: share, spent: me.hours, gap: share === null ? null : round2(me.hours - share), state,
        mine: (u.main || []).includes(m.id), with: (u.people || []).filter((p) => p.id !== m.id).map((p) => p.name).join(', ') };
    }).filter(Boolean).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    return { id: m.id, name: m.name, color: m.color, inactive: m.inactive,
      days: a ? a.days : 0, late: a ? a.late : 0, presence: m.presence, work: m.work, productivity: m.productivity,
      interventions: m.interventions, planned: m.planned, spent: m.spent, gap: m.gap, overruns: m.overruns, to_check: m.to_check, rows };
  }).filter((m) => !m.inactive || m.work > 0 || m.presence > 0);
  const sum = (k) => round2(mechanics.reduce((s, m) => s + (Number(m[k]) || 0), 0));
  const totals = { presence: sum('presence'), work: sum('work'), interventions: sum('interventions'), planned: sum('planned'), spent: sum('spent'),
    gap: round2(sum('spent') - sum('planned')), overruns: sum('overruns'), to_check: sum('to_check') };
  totals.productivity = totals.presence ? Math.round((totals.work / totals.presence) * 100) : null;
  const overruns = stats.interventions.filter((u) => u.over > 0 && !u.auto);
  const toCheck = stats.interventions.filter((u) => u.auto);
  return { ...b, mechanics, totals, overruns, to_check: toCheck };
}

// ---------- Mise en page pour l'e-mail (tableaux simples, lisibles dans toutes les messageries) ----------
const TH = 'padding:6px 8px;background:#f3f4f6;font-size:12px;text-align:left;border-bottom:1px solid #ddd';
const TD = 'padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top';
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
    html += htmlTable(['Date', 'OR', 'Intervention', 'Prévu', 'Passé', 'Écart', ''], m.rows.map((r) => [
      fdate(r.date), `${esc(r.number || '')}${r.plate ? `<br><span style="color:#777;font-size:11px">${esc(r.plate)}</span>` : ''}`,
      `${esc(r.description)}${r.with ? `<br><span style="color:#777;font-size:11px">avec ${esc(r.with)}</span>` : ''}`,
      r.planned === null ? '—' : hm(r.planned), hm(r.spent), gapHtml(r.gap), STATE[r.state] || '',
    ]), [3, 4, 5]);
  } else html += '<p style="font-size:13px;color:#555">Aucune intervention chronométrée ce mois-ci.</p>';
  return html + NOTE;
}

/** Rapport de toute l'équipe (bloc HTML placé dans l'e-mail du gérant). */
export function teamHtml(rep, delivery = null) {
  let html = `<h3 style="margin:18px 0 4px">Rapport de l'atelier — ${esc(rep.label)}</h3><div style="color:#555;font-size:13px">Du ${fdate(rep.from)} au ${fdate(rep.to)}</div>`;
  const row = (m, bold = false) => {
    const w = (v) => (bold ? `<b>${v}</b>` : v);
    return [w(esc(m.name) + (m.inactive ? ' <span style="color:#777">(inactif)</span>' : '')), w(m.days ?? ''), w(hm(m.presence)),
      w(`${hm(m.work)}${m.productivity !== null && m.productivity !== undefined ? ` <span style="color:#777;font-weight:normal">${m.productivity} %</span>` : ''}`),
      w(esc(m.interventions)), w(m.interventions ? hm(m.planned) : '—'), w(m.interventions ? hm(m.spent) : '—'), m.interventions ? gapHtml(m.gap) : '—',
      m.overruns ? `<span style="${RED}">${esc(m.overruns)}</span>` : w('0')];
  };
  html += htmlTable(['Mécanicien', 'Jours', 'Présence', 'Sur OR', 'Interv.', 'Prévu', 'Passé', 'Écart', 'Dépass.'],
    [...rep.mechanics.map((m) => row(m)), row({ name: 'Total équipe', days: '', ...rep.totals }, true)], [1, 2, 3, 4, 5, 6, 7, 8]);
  if (rep.overruns.length) {
    html += '<h4 style="margin:14px 0 2px">Interventions en dépassement</h4>';
    html += htmlTable(['Intervention', 'OR', 'Mécanicien(s)', 'Prévu', 'Passé', 'Écart'], rep.overruns.map((u) => [
      esc(u.description), `${esc(u.number || '')}${u.plate ? ` <span style="color:#777">${esc(u.plate)}</span>` : ''}`, esc(u.mechanics),
      hm(u.planned), hm(u.spent), gapHtml(u.over)]), [3, 4, 5]);
  } else html += '<p style="font-size:13px;color:#047857">Aucune intervention en dépassement ce mois-ci.</p>';
  if (rep.to_check.length) {
    html += '<h4 style="margin:14px 0 2px">À vérifier (chrono oublié, arrêté automatiquement)</h4>';
    html += htmlTable(['Intervention', 'OR', 'Mécanicien(s)', 'Durée enregistrée'], rep.to_check.map((u) => [esc(u.description), esc(u.number || ''), esc(u.mechanics), hm(u.spent)]), [3]);
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
  const lastOf = (kind, userId, addr) => runs.filter((r) => r.kind === kind && (userId ? r.user_id === userId : r.to_addr === addr)).pop() || null;
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

const log = (month, kind, userId, to, status, error, auto) => run('INSERT INTO report_runs(month, kind, user_id, to_addr, status, error, auto, sent_at) VALUES(?,?,?,?,?,?,?,?)',
  month, kind, userId, to, status, error ? String(error).slice(0, 300) : null, auto ? 1 : 0, localDateTime());

/**
 * Envoie les rapports d'un mois : à chaque mécanicien actif qui a travaillé et possède une adresse → son rapport ;
 * aux administrateurs → le rapport de l'équipe. « only » limite l'envoi : { mechanic: id } ou { team: true }.
 * Sans « force », ce qui a déjà été envoyé avec succès pour ce mois n'est pas renvoyé.
 */
export async function sendMonthlyReports(ym, { force = false, auto = false, only = null, extra = '', userId = null } = {}) {
  if (!isMailConfigured()) throw new BusinessError('L\'envoi d\'e-mails n\'est pas configuré (Paramètres → E-mails) : aucun rapport n\'a été envoyé.');
  const rep = monthlyReport(ym);
  const already = (kind, uid, addr) => !force && !!get(`SELECT 1 FROM report_runs WHERE month=? AND kind=? AND status='sent' AND ${uid ? 'user_id=?' : 'to_addr=?'}`, ym, kind, uid || addr);
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
 * à l'heure choisie, une seule fois par mois. Renvoie null si rien n'était à faire.
 */
let running = false;
export async function runMonthlyReports(opts, now = new Date()) {
  if (!opts?.monthly_report || running) return null;
  if (now.getDate() > 10 || now.toTimeString().slice(0, 5) < (opts.monthly_report_time || '07:00')) return null;
  const ym = previousMonth(now);
  if (get("SELECT 1 FROM report_runs WHERE month=? AND kind='auto'", ym)) return null;
  if (!isMailConfigured()) return null; // on réessaiera : rien n'est marqué comme envoyé
  running = true;
  try {
    // marqué d'abord : même si le logiciel s'arrête pendant l'envoi, les rapports ne partent pas deux fois
    log(ym, 'auto', null, null, 'started', null, true);
    const r = await sendMonthlyReports(ym, { auto: true, extra: opts.report_to });
    run("UPDATE report_runs SET status=?, error=? WHERE month=? AND kind='auto'", r.failed ? 'partial' : 'done', r.failed ? `${r.failed} envoi(s) en échec` : null, ym);
    return r;
  } catch (e) {
    run("UPDATE report_runs SET status='error', error=? WHERE month=? AND kind='auto'", String(e.message).slice(0, 300), ym);
    throw e;
  } finally { running = false; }
}
