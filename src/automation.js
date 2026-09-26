// Options de configuration inspirées d'Odoo et leurs automatismes :
// relances de paiement par niveaux, rappels de rendez-vous la veille, départ automatique des pointages.
import { db, all, get, run, insert, today, localDate, getSettings } from './db.js';
import { compose, sendEmail, createActivity, isMailConfigured } from './mail.js';
import { autoCheckout } from './attendance.js';
import { publishDue } from './social.js';

db.exec(`
CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, level INTEGER NOT NULL,
  action TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(document_id, level)
);
CREATE TABLE IF NOT EXISTS appointment_reminders (
  appointment_id INTEGER PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE, sent_at TEXT DEFAULT CURRENT_TIMESTAMP, status TEXT
);`);

export const OPTION_DEFAULTS = {
  ventes: { quote_validity_days: 30, line_discounts: true, default_note: '' },
  relances: {
    enabled: false, auto_send: false, run_time: '09:00',
    levels: [
      { days: 3, name: 'Rappel courtois', action: 'email' },
      { days: 15, name: 'Relance', action: 'email' },
      { days: 30, name: 'Mise en demeure', action: 'activity' },
    ],
  },
  rendez_vous: { reminder: false, reminder_time: '17:00', default_duration: 60 },
  comptabilite: { lock_date: '', vat_period: 'quarter', fiscal_year_start: '01-01' },
  inventaire: { allow_negative: true },
  achats: { approval: false, approval_amount: 2500 },
  general: { start_page: 'apps', home_background: 'aurora' },
};

export function options() {
  const saved = getSettings().options || {};
  const out = {};
  for (const [k, def] of Object.entries(OPTION_DEFAULTS)) out[k] = { ...def, ...(saved[k] || {}) };
  return out;
}

/** Garde uniquement les options connues, avec le bon type. */
export function cleanOptions(input = {}) {
  const cur = options();
  const out = structuredClone(cur);
  for (const [sec, def] of Object.entries(OPTION_DEFAULTS)) {
    const src = input[sec];
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(def)) {
      if (!(k in src)) continue;
      if (typeof v === 'boolean') out[sec][k] = Boolean(src[k]);
      else if (typeof v === 'number') { const n = Number(src[k]); if (Number.isFinite(n) && n >= 0) out[sec][k] = n; }
      else if (typeof v === 'string') out[sec][k] = String(src[k] ?? '').slice(0, 300);
      else if (Array.isArray(v) && Array.isArray(src[k])) {
        out[sec][k] = src[k].slice(0, 6).map((l) => ({ days: Math.max(0, Math.round(Number(l.days) || 0)), name: String(l.name || 'Relance').slice(0, 60), action: l.action === 'activity' ? 'activity' : 'email' }))
          .sort((a, b) => a.days - b.days);
      }
    }
  }
  if (out.comptabilite.lock_date && !/^\d{4}-\d{2}-\d{2}$/.test(out.comptabilite.lock_date)) out.comptabilite.lock_date = cur.comptabilite.lock_date;
  if (!['month', 'quarter', 'year'].includes(out.comptabilite.vat_period)) out.comptabilite.vat_period = 'quarter';
  if (!['apps', 'dashboard'].includes(out.general.start_page)) out.general.start_page = 'apps';
  for (const k of ['run_time']) if (!/^\d{2}:\d{2}$/.test(out.relances[k])) out.relances[k] = '09:00';
  if (!/^\d{2}:\d{2}$/.test(out.rendez_vous.reminder_time)) out.rendez_vous.reminder_time = '17:00';
  return out;
}

const admins = () => all("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id");
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);

/** Relances de paiement (comme le « Suivi des paiements » d'Odoo). */
export async function runFollowups({ force = false } = {}) {
  const o = options().relances;
  if (!o.enabled && !force) return { done: [] };
  const t = today();
  const invoices = all(`SELECT d.*, c.name AS customer_name, c.email FROM documents d LEFT JOIN customers c ON c.id=d.customer_id
    WHERE d.type='invoice' AND d.status IN ('posted','partial') AND d.due_date < ?`, t);
  const done = [];
  for (const d of invoices) {
    const late = daysBetween(d.due_date, t);
    const reached = o.levels.map((l, i) => ({ ...l, level: i + 1 })).filter((l) => late >= l.days);
    const lvl = reached.at(-1);
    if (!lvl || get('SELECT 1 FROM followups WHERE document_id=? AND level>=?', d.id, lvl.level)) continue;
    const residual = Math.round((d.total - d.amount_paid) * 100) / 100;
    let action = 'activity';
    if (lvl.action === 'email' && o.auto_send && d.email && isMailConfigured()) {
      try {
        const m = compose('document', d.id, 'invoice_reminder');
        await sendEmail({ model: 'document', record_id: d.id, to: d.email, subject: `${lvl.name} — ${m.subject}`, intro: m.intro, include_document: true, user_id: null });
        action = 'email';
      } catch { action = 'activity'; }
    }
    if (action === 'activity') {
      for (const a of admins().slice(0, 1)) {
        createActivity({ model: 'document', record_id: d.id, module: 'ventes', type: lvl.action === 'email' ? 'email' : 'payment',
          summary: `${lvl.name} : ${d.number} — ${d.customer_name} (${residual.toFixed(2)} €, ${late} j de retard)`, due_date: t, user_id: a.id }, a.id);
      }
    }
    insert('followups', { document_id: d.id, level: lvl.level, action }, ['document_id', 'level', 'action']);
    done.push({ number: d.number, level: lvl.level, name: lvl.name, action });
  }
  return { done };
}

/** Rappel envoyé au client la veille de son rendez-vous. */
export async function runAppointmentReminders({ force = false } = {}) {
  const o = options().rendez_vous;
  if ((!o.reminder || !isMailConfigured()) && !force) return { sent: 0 };
  const d = new Date(); d.setDate(d.getDate() + 1);
  const tomorrow = localDate(d);
  const rows = all(`SELECT a.id, c.email FROM appointments a JOIN customers c ON c.id=a.customer_id
    WHERE substr(a.start,1,10)=? AND a.status!='cancelled' AND c.email LIKE '%@%' AND a.id NOT IN (SELECT appointment_id FROM appointment_reminders)`, tomorrow);
  let sent = 0;
  for (const r of rows) {
    let status = 'sent';
    try {
      const m = compose('appointment', r.id, 'appointment_confirm');
      await sendEmail({ model: 'appointment', record_id: r.id, to: r.email, subject: `Rappel : ${m.subject}`, intro: m.intro, include_document: false });
      sent++;
    } catch (e) { status = 'error: ' + e.message.slice(0, 100); }
    insert('appointment_reminders', { appointment_id: r.id, status }, ['appointment_id', 'status']);
  }
  return { sent };
}

// Planificateur : chaque tâche une fois par jour à son heure
const lastRun = {};
async function tick() {
  const now = new Date();
  const hm = now.toTimeString().slice(0, 5);
  const t = today();
  const o = options();
  try { autoCheckout(); } catch (e) { console.error('Départ automatique', e); }
  publishDue(getSettings().public_url).catch((e) => console.error('Publications programmées', e));
  const due = (key, time) => hm >= time && lastRun[key] !== t && (lastRun[key] = t);
  if (o.relances.enabled && due('followups', o.relances.run_time)) runFollowups().catch((e) => console.error('Relances', e));
  if (o.rendez_vous.reminder && due('reminders', o.rendez_vous.reminder_time)) runAppointmentReminders().catch((e) => console.error('Rappels RDV', e));
}
export function startAutomation() {
  setTimeout(tick, 5000);
  setInterval(tick, 60_000);
}
