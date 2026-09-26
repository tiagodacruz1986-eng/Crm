// Nova — copilote IA du gérant : écoute (voix ou texte), note le journal de la journée,
// agit (activités, rendez-vous), fait le résumé de fin de journée et planifie les priorités.
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { db, all, get, insert, getSettings, setSetting, round2, today, localDate, localDateTime } from './db.js';
import { BusinessError, durationHours } from './business.js';
import { TOOLS, runTool } from './agents.js';
import { runLoop, aiConfigured, claudeClient, CLAUDE_MODEL, friendlyError } from './claude.js';
import { createActivity, sendEmail, MODULES, ACTIVITY_TYPES } from './mail.js';

db.exec(`
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT NOT NULL, source TEXT DEFAULT 'text', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS daily_briefs (
  id INTEGER PRIMARY KEY, date TEXT UNIQUE NOT NULL, content TEXT, priorities TEXT, stats TEXT, ai INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

const DEFAULTS = { enabled: true, summary_time: '18:30', auto_plan: true, email_me: false, voice: true };
export const copilotConfig = () => ({ ...DEFAULTS, ...(getSettings().copilot || {}) });
export const saveCopilotConfig = (c) => setSetting('copilot', { ...copilotConfig(), ...c });

// ---------- Journal ----------
export function addJournal(text, userId, source = 'text') {
  if (!text?.trim()) throw new BusinessError('Note vide');
  return insert('journal', { user_id: userId, text: text.trim().slice(0, 4000), source, created_at: localDateTime() }, ['user_id', 'text', 'source', 'created_at']);
}
export const journalOf = (date) => all(`SELECT j.*, u.name AS user_name FROM journal j LEFT JOIN users u ON u.id=j.user_id WHERE substr(j.created_at,1,10)=? ORDER BY j.id`, date);

// ---------- Chiffres de la journée ----------
export function dayStats(date = today()) {
  const next = (() => { const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + 1); return localDate(d); })();
  const sum = (sql, ...p) => round2(get(sql, ...p)?.v || 0);
  const invoices = all(`SELECT d.number, d.total, c.name AS client FROM documents d LEFT JOIN customers c ON c.id=d.customer_id WHERE d.type='invoice' AND substr(d.posted_at,1,10)=?`, date);
  const time = all(`SELECT * FROM time_entries WHERE substr(start,1,10)=?`, date);
  const mechanics = all("SELECT id, name FROM users WHERE role='mechanic' AND active=1").map((u) => {
    const mine = time.filter((t) => t.user_id === u.id);
    return { nom: u.name, heures_presence: round2(mine.filter((t) => t.kind === 'presence').reduce((s, t) => s + durationHours(t), 0)), heures_sur_or: round2(mine.filter((t) => t.kind === 'work').reduce((s, t) => s + durationHours(t), 0)) };
  });
  return {
    date,
    ca_facture_ttc: round2(invoices.reduce((s, i) => s + i.total, 0)),
    factures_emises: invoices,
    encaissements: sum(`SELECT SUM(amount) v FROM payments WHERE direction='in' AND date=?`, date),
    paiements_fournisseurs: sum(`SELECT SUM(amount) v FROM payments WHERE direction='out' AND date=?`, date),
    or_crees: get(`SELECT COUNT(*) n FROM documents WHERE type='order' AND substr(created_at,1,10)=?`, date).n,
    or_termines_a_facturer: all(`SELECT d.number, v.plate FROM documents d LEFT JOIN vehicles v ON v.id=d.vehicle_id WHERE d.type='order' AND d.status='done'`).slice(0, 20),
    or_en_retard: all(`SELECT d.number, v.plate, d.promised_at, c.name AS client FROM documents d LEFT JOIN vehicles v ON v.id=d.vehicle_id LEFT JOIN customers c ON c.id=d.customer_id
      WHERE d.type='order' AND d.status IN ('open','in_progress','waiting_parts') AND d.promised_at IS NOT NULL AND substr(d.promised_at,1,10)<=?`, date),
    or_attente_pieces: get(`SELECT COUNT(*) n FROM documents WHERE type='order' AND status='waiting_parts'`).n,
    mecaniciens: mechanics,
    rendez_vous_demain: all(`SELECT a.start, a.title, c.name AS client, v.plate FROM appointments a LEFT JOIN customers c ON c.id=a.customer_id LEFT JOIN vehicles v ON v.id=a.vehicle_id WHERE substr(a.start,1,10)=? ORDER BY a.start`, next),
    factures_en_retard: all(`SELECT d.number, c.name AS client, ROUND(d.total-d.amount_paid,2) AS reste, d.due_date FROM documents d JOIN customers c ON c.id=d.customer_id
      WHERE d.type='invoice' AND d.status IN ('posted','partial') AND d.due_date<? ORDER BY d.due_date LIMIT 15`, date),
    devis_en_attente: all(`SELECT d.number, c.name AS client, d.total, d.date FROM documents d LEFT JOIN customers c ON c.id=d.customer_id WHERE d.type='quote' AND d.status IN ('draft','sent') ORDER BY d.date LIMIT 10`),
    accords_client_en_attente: all(`SELECT p.body, p.amount, d.number FROM order_posts p JOIN documents d ON d.id=p.document_id WHERE p.kind='approval' AND p.answer IS NULL`).slice(0, 10),
    messages_clients_du_jour: all(`SELECT p.body, d.number FROM order_posts p JOIN documents d ON d.id=p.document_id WHERE p.author_role='customer' AND substr(p.created_at,1,10)=?`, date).slice(0, 10),
    stock_bas: all('SELECT ref, name, qty_on_hand, qty_min FROM products WHERE active=1 AND is_service=0 AND qty_min>0 AND qty_on_hand<=qty_min LIMIT 15'),
    factures_fournisseurs_a_verifier: get(`SELECT COUNT(*) n FROM purchases WHERE review='to_review' AND posted=0`).n,
    activites_faites: all(`SELECT summary FROM activities WHERE status='done' AND substr(done_at,1,10)=?`, date),
    activites_en_retard: all(`SELECT summary, due_date FROM activities WHERE status='planned' AND due_date<=?`, date).slice(0, 15),
    controles_techniques_7j: all(`SELECT v.plate, c.name AS client, v.next_inspection FROM vehicles v LEFT JOIN customers c ON c.id=v.customer_id WHERE v.next_inspection BETWEEN ? AND date(?, '+7 days')`, date, date).slice(0, 15),
    journal: journalOf(date).map((j) => `${j.created_at.slice(11, 16)} ${j.text}`),
  };
}

// ---------- Outils du copilote (lecture + actions) ----------
const ACTION_TOOLS = [
  {
    name: 'noter_journal', description: 'Enregistre une note dans le journal du jour (ce que le gérant dit, une info à retenir, un événement). Utilise-le dès que le gérant te dicte une information.',
    input_schema: { type: 'object', properties: { texte: { type: 'string' } }, required: ['texte'], additionalProperties: false },
  },
  {
    name: 'planifier_activite', description: 'Planifie une tâche / un rappel / un appel dans le logiciel, avec une échéance.',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['resume', 'date'],
      properties: {
        resume: { type: 'string' }, date: { type: 'string', description: 'AAAA-MM-JJ' }, heure: { type: 'string', description: 'HH:MM' },
        type: { type: 'string', enum: Object.keys(ACTIVITY_TYPES) }, module: { type: 'string', enum: Object.keys(MODULES) }, note: { type: 'string' },
        repetition: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'] },
      },
    },
  },
  {
    name: 'creer_rendez_vous', description: 'Crée un rendez-vous atelier pour un client (recherché par nom ou plaque).',
    input_schema: {
      type: 'object', additionalProperties: false, required: ['client', 'debut'],
      properties: { client: { type: 'string', description: 'nom du client ou plaque' }, debut: { type: 'string', description: 'AAAA-MM-JJTHH:MM' }, duree_minutes: { type: 'integer' }, motif: { type: 'string' } },
    },
  },
  {
    name: 'chiffres_du_jour', description: 'Bilan chiffré d\'une journée (factures, encaissements, OR, heures des mécaniciens, retards, rendez-vous du lendemain, journal).',
    input_schema: { type: 'object', properties: { date: { type: 'string', description: 'AAAA-MM-JJ, aujourd\'hui par défaut' } }, additionalProperties: false },
  },
];

function execCopilotTool(name, input, userId) {
  switch (name) {
    case 'noter_journal': return { id: addJournal(input.texte, userId, 'ia'), ok: true };
    case 'planifier_activite': {
      const id = createActivity({ summary: input.resume, due_date: input.date, due_time: input.heure, type: input.type || 'todo', module: input.module || 'general', note: input.note, recurrence: input.repetition || 'none' }, userId);
      return { id, ok: true };
    }
    case 'creer_rendez_vous': {
      const q = `%${input.client}%`;
      const c = get(`SELECT c.id, c.name, (SELECT id FROM vehicles WHERE customer_id=c.id ORDER BY id DESC LIMIT 1) AS vehicle_id FROM customers c
        LEFT JOIN vehicles v ON v.customer_id=c.id WHERE c.name LIKE ? OR c.company LIKE ? OR REPLACE(v.plate,' ','') LIKE REPLACE(?,' ','') LIMIT 1`, q, q, q);
      if (!c) throw new Error(`Client « ${input.client} » introuvable`);
      const start = new Date(input.debut);
      if (Number.isNaN(start.getTime())) throw new Error('Date de début invalide');
      const end = new Date(start.getTime() + (input.duree_minutes || 60) * 60000);
      const id = insert('appointments', { customer_id: c.id, vehicle_id: c.vehicle_id, start: localDateTime(start).slice(0, 16), end: localDateTime(end).slice(0, 16), title: input.motif || 'Rendez-vous' },
        ['customer_id', 'vehicle_id', 'start', 'end', 'title']);
      return { id, client: c.name, ok: true };
    }
    case 'chiffres_du_jour': return dayStats(input.date || today());
    default: return runTool(name, input);
  }
}

const ACTION_LABEL = { noter_journal: '📓 Noté dans le journal', planifier_activite: '⏰ Activité planifiée', creer_rendez_vous: '📅 Rendez-vous créé' };

function copilotSystem(user) {
  const s = getSettings();
  const now = new Date();
  return `Tu es Nova, le copilote IA vocal de ${user?.name || 'gérant'}, gérant du garage « ${s.company.name} » au Luxembourg.
Tu l'écoutes toute la journée : quand il te dicte une information, note-la avec noter_journal ; quand il te demande de faire quelque chose (rappel, tâche, rendez-vous), fais-le avec tes outils puis confirme en une phrase.
Pour les questions, consulte les données réelles du garage avec tes outils avant de répondre.
Tes réponses sont lues à voix haute : sois bref (2 à 4 phrases), naturel, sans tableaux ni listes longues, en français. Donne les montants arrondis.
Si une date est relative (« demain », « jeudi »), convertis-la toi-même en date exacte.
${s.ai?.garage_context ? `Contexte du garage : ${s.ai.garage_context}\n` : ''}Nous sommes le ${now.toLocaleDateString('fr-LU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, il est ${now.toLocaleTimeString('fr-LU', { hour: '2-digit', minute: '2-digit' })} (date ISO ${today()}).`;
}

export async function copilotChat(user, message, history = []) {
  if (!message?.trim()) throw new BusinessError('Message vide');
  const actions = [];
  if (!aiConfigured()) {
    // Sans IA : on garde au moins la note dans le journal
    addJournal(message, user.id, 'voice');
    return { reply: 'Mode démo : j\'ai noté cela dans votre journal. Ajoutez la clé API Claude pour que je puisse répondre et agir.', actions: [ACTION_LABEL.noter_journal] };
  }
  const messages = [...history.slice(-12).filter((m) => m.role && m.content), { role: 'user', content: message.trim() }];
  while (messages.length && messages[0].role !== 'user') messages.shift();
  try {
    const reply = await runLoop({
      system: copilotSystem(user), messages, tools: [...TOOLS, ...ACTION_TOOLS], webSearch: true,
      execTool: (n, i) => execCopilotTool(n, i, user.id),
      onTool: (n, i) => { if (ACTION_LABEL[n]) actions.push(`${ACTION_LABEL[n]}${i.resume || i.motif || i.texte ? ` : ${(i.resume || i.motif || i.texte).slice(0, 80)}` : ''}`); },
    });
    return { reply, actions };
  } catch (e) {
    throw new BusinessError(friendlyError(e));
  }
}

// ---------- Résumé de fin de journée ----------
const BRIEF_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['resume', 'priorites'],
  properties: {
    resume: { type: 'string', description: 'Résumé de la journée en Markdown : chiffres clés, ce qui s\'est passé, points d\'attention.' },
    priorites: {
      type: 'array', description: '3 à 6 actions importantes à planifier, les plus urgentes d\'abord.',
      items: {
        type: 'object', additionalProperties: false, required: ['resume', 'pourquoi', 'echeance', 'type', 'module'],
        properties: {
          resume: { type: 'string' }, pourquoi: { type: 'string' }, echeance: { type: 'string', description: 'AAAA-MM-JJ' },
          type: { type: 'string', enum: Object.keys(ACTIVITY_TYPES) }, module: { type: 'string', enum: Object.keys(MODULES) },
        },
      },
    },
  },
};

// Version sans IA : règles simples
function ruleBasedBrief(st) {
  const tomorrow = (() => { const d = new Date(st.date + 'T12:00:00'); d.setDate(d.getDate() + 1); return localDate(d); })();
  const p = [];
  if (st.factures_en_retard.length) p.push({ resume: `Relancer ${st.factures_en_retard.length} facture(s) en retard (${round2(st.factures_en_retard.reduce((s, f) => s + f.reste, 0))} €)`, pourquoi: 'Trésorerie', echeance: tomorrow, type: 'payment', module: 'comptabilite' });
  if (st.or_en_retard.length) p.push({ resume: `Prévenir les clients des ${st.or_en_retard.length} OR en retard`, pourquoi: 'Satisfaction client', echeance: tomorrow, type: 'call', module: 'atelier' });
  if (st.accords_client_en_attente.length) p.push({ resume: `Relancer ${st.accords_client_en_attente.length} accord(s) client en attente`, pourquoi: 'Travaux bloqués', echeance: tomorrow, type: 'call', module: 'atelier' });
  if (st.stock_bas.length) p.push({ resume: `Commander ${st.stock_bas.length} article(s) sous le stock minimum`, pourquoi: 'Éviter les ruptures', echeance: tomorrow, type: 'order', module: 'stock' });
  if (st.factures_fournisseurs_a_verifier) p.push({ resume: `Vérifier ${st.factures_fournisseurs_a_verifier} facture(s) fournisseur`, pourquoi: 'Comptabilité à jour', echeance: tomorrow, type: 'todo', module: 'achats' });
  if (st.devis_en_attente.length) p.push({ resume: `Relancer ${st.devis_en_attente.length} devis en attente`, pourquoi: 'Chiffre d\'affaires', echeance: tomorrow, type: 'call', module: 'ventes' });
  const h = st.mecaniciens.map((m) => `${m.nom} ${m.heures_sur_or} h`).join(', ');
  const resume = `## Journée du ${new Date(st.date + 'T12:00').toLocaleDateString('fr-LU', { weekday: 'long', day: 'numeric', month: 'long' })}
- **Facturé** : ${st.ca_facture_ttc.toFixed(2)} € TTC (${st.factures_emises.length} facture(s)) · **Encaissé** : ${st.encaissements.toFixed(2)} €
- **Atelier** : ${st.or_crees} OR créé(s), ${st.or_en_retard.length} en retard, ${st.or_attente_pieces} en attente de pièces${h ? ` · heures sur OR : ${h}` : ''}
- **Demain** : ${st.rendez_vous_demain.length} rendez-vous
- **Impayés** : ${st.factures_en_retard.length} facture(s) en retard${st.journal.length ? `\n\n**Journal** :\n${st.journal.map((j) => `- ${j}`).join('\n')}` : ''}`;
  return { resume, priorites: p.slice(0, 6) };
}

export async function generateBrief({ date = today(), force = false } = {}) {
  const existing = get('SELECT * FROM daily_briefs WHERE date=?', date);
  if (existing && !force) return existing;
  const st = dayStats(date);
  let out, ai = 0;
  if (aiConfigured()) {
    try {
      const resp = await claudeClient().messages.parse({
        model: CLAUDE_MODEL, max_tokens: 16000,
        messages: [{
          role: 'user',
          content: `Tu es Nova, copilote du gérant d'un garage automobile au Luxembourg. Voici les données de la journée du ${date} (JSON), y compris le journal de ce qu'il a dit ou noté :
${JSON.stringify(st)}

Écris son résumé de fin de journée (clair, concret, chiffré, ton chaleureux et direct, 150 à 250 mots, en Markdown avec quelques titres courts) puis propose 3 à 6 priorités à planifier (échéance à partir du ${date}, les plus importantes d'abord). Ne invente aucun chiffre.`,
        }],
        output_config: { format: jsonSchemaOutputFormat(BRIEF_SCHEMA) },
      });
      if (resp.parsed_output) { out = resp.parsed_output; ai = 1; }
    } catch (e) {
      console.error('Résumé IA :', e.message);
    }
  }
  out ||= ruleBasedBrief(st);
  const cfg = copilotConfig();
  const admin = get("SELECT id, email FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1");
  const created = [];
  if (cfg.auto_plan && admin) {
    for (const p of out.priorites) {
      const due = /^\d{4}-\d{2}-\d{2}$/.test(p.echeance) && p.echeance >= date ? p.echeance : date;
      const dup = get("SELECT id FROM activities WHERE status='planned' AND summary=?", `🧠 ${p.resume}`);
      if (dup) continue;
      created.push(createActivity({ summary: `🧠 ${p.resume}`, note: p.pourquoi, due_date: due, type: p.type, module: p.module }, admin.id));
    }
  }
  const row = { date, content: out.resume, priorities: JSON.stringify(out.priorites), stats: JSON.stringify(st), ai };
  if (existing) db.prepare('UPDATE daily_briefs SET content=?, priorities=?, stats=?, ai=?, created_at=CURRENT_TIMESTAMP WHERE date=?').run(row.content, row.priorities, row.stats, ai, date);
  else insert('daily_briefs', row, ['date', 'content', 'priorities', 'stats', 'ai']);
  insert('agent_results', { agent_id: 'cio', title: `🧠 Résumé de la journée du ${date}`, content: `${out.resume}\n\n### Priorités planifiées\n${out.priorites.map((p, i) => `${i + 1}. **${p.resume}** — ${p.pourquoi} (${p.echeance})`).join('\n')}` },
    ['agent_id', 'title', 'content']);
  if (cfg.email_me && admin?.email) {
    sendEmail({ to: admin.email, subject: `🧠 Résumé de votre journée — ${date}`, intro: `${out.resume.replace(/[#*]/g, '')}\n\nPriorités :\n${out.priorites.map((p, i) => `${i + 1}. ${p.resume} (${p.echeance})`).join('\n')}`, user_id: admin.id })
      .catch((e) => console.error('E-mail du résumé :', e.message));
  }
  return { ...get('SELECT * FROM daily_briefs WHERE date=?', date), created: created.length };
}

export function listBriefs(limit = 14) {
  return all('SELECT id, date, content, priorities, ai, created_at FROM daily_briefs ORDER BY date DESC LIMIT ?', limit)
    .map((b) => ({ ...b, priorities: JSON.parse(b.priorities || '[]') }));
}

// Déclenchement automatique à l'heure choisie (une fois par jour)
export function startCopilotScheduler() {
  setInterval(() => {
    const cfg = copilotConfig();
    if (!cfg.enabled) return;
    const now = localDateTime().slice(11, 16);
    if (now < cfg.summary_time || get('SELECT 1 FROM daily_briefs WHERE date=?', today())) return;
    generateBrief().catch((e) => console.error('Résumé de fin de journée :', e.message));
  }, 60_000);
}
