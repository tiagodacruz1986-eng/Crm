// CRM (inspiré d'Odoo) : pistes et opportunités dans un pipeline par étapes, sources, montants attendus,
// probabilité, gagné / perdu, conversion en client et en devis. Les demandes du site web arrivent ici.
import { db, all, get, run, insert, update, tx, round2, today } from './db.js';
import { BusinessError, saveDocument } from './business.js';

db.exec(`
CREATE TABLE IF NOT EXISTS crm_stages (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, sequence INTEGER DEFAULT 10, probability INTEGER DEFAULT 10,
  is_won INTEGER DEFAULT 0, fold INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS crm_leads (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact_name TEXT, email TEXT, phone TEXT, company TEXT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  vehicle_plate TEXT, vehicle_desc TEXT, service TEXT, description TEXT,
  stage_id INTEGER REFERENCES crm_stages(id), expected_revenue REAL DEFAULT 0, probability INTEGER DEFAULT 10,
  priority INTEGER DEFAULT 0, source TEXT DEFAULT 'manuel', user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deadline TEXT, status TEXT DEFAULT 'open', lost_reason TEXT, quote_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  tags TEXT, sequence INTEGER DEFAULT 0, won_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON crm_leads(stage_id, status);
`);
if (!get('SELECT COUNT(*) n FROM crm_stages').n) {
  for (const [name, seq, prob, won] of [['Nouveau', 10, 10, 0], ['Qualifié', 20, 30, 0], ['Devis envoyé', 30, 60, 0], ['Négociation', 40, 80, 0], ['Gagné', 50, 100, 1]]) {
    insert('crm_stages', { name, sequence: seq, probability: prob, is_won: won }, ['name', 'sequence', 'probability', 'is_won']);
  }
}

export const SOURCES = { site: 'Site web', telephone: 'Téléphone', social: 'Réseaux sociaux', passage: 'Passage au garage', recommandation: 'Recommandation', email: 'E-mail', manuel: 'Autre' };
export const LOST_REASONS = ['Trop cher', 'Délai trop long', 'Parti chez un concurrent', 'Plus de réponse', 'Travaux reportés', 'Autre'];
const LEAD_COLS = ['name', 'contact_name', 'email', 'phone', 'company', 'customer_id', 'vehicle_plate', 'vehicle_desc', 'service', 'description', 'stage_id',
  'expected_revenue', 'probability', 'priority', 'source', 'user_id', 'deadline', 'status', 'lost_reason', 'quote_id', 'tags', 'sequence', 'won_at'];

export const stages = () => all('SELECT * FROM crm_stages ORDER BY sequence, id');
const firstStage = () => stages()[0];

export function listLeads({ q, status = 'open', user_id, source } = {}) {
  const where = [];
  const p = [];
  if (status && status !== 'all') { where.push('l.status=?'); p.push(status); }
  if (user_id) { where.push('l.user_id=?'); p.push(Number(user_id)); }
  if (source) { where.push('l.source=?'); p.push(source); }
  if (q?.trim()) {
    where.push('(l.name LIKE ? OR l.contact_name LIKE ? OR l.email LIKE ? OR l.phone LIKE ? OR l.vehicle_plate LIKE ? OR l.company LIKE ?)');
    p.push(...Array(6).fill(`%${q.trim()}%`));
  }
  return all(`SELECT l.*, u.name AS user_name, u.color AS user_color, c.name AS customer_name, d.number AS quote_number,
      (SELECT COUNT(*) FROM activities a WHERE a.model='lead' AND a.record_id=l.id AND a.status='planned') AS activities,
      (SELECT MIN(due_date) FROM activities a WHERE a.model='lead' AND a.record_id=l.id AND a.status='planned') AS next_activity
    FROM crm_leads l LEFT JOIN users u ON u.id=l.user_id LEFT JOIN customers c ON c.id=l.customer_id LEFT JOIN documents d ON d.id=l.quote_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.priority DESC, l.sequence, l.id DESC`, ...p);
}

export function getLead(id) {
  const l = get(`SELECT l.*, u.name AS user_name, c.name AS customer_name, d.number AS quote_number, d.total AS quote_total, s.name AS stage_name
    FROM crm_leads l LEFT JOIN users u ON u.id=l.user_id LEFT JOIN customers c ON c.id=l.customer_id LEFT JOIN documents d ON d.id=l.quote_id
    LEFT JOIN crm_stages s ON s.id=l.stage_id WHERE l.id=?`, id);
  if (!l) throw new BusinessError('Opportunité introuvable', 404);
  return l;
}

export function saveLead(data, id = null) {
  const d = { ...data };
  if (!id && !d.name?.trim()) {
    d.name = [d.service, d.contact_name || d.company].filter(Boolean).join(' — ') || 'Nouvelle demande';
  }
  if (d.name !== undefined) d.name = String(d.name).slice(0, 160);
  if (d.expected_revenue !== undefined) d.expected_revenue = round2(Math.max(0, Number(d.expected_revenue) || 0));
  if (d.probability !== undefined) d.probability = Math.min(100, Math.max(0, Math.round(Number(d.probability) || 0)));
  if (d.priority !== undefined) d.priority = Math.min(3, Math.max(0, Number(d.priority) || 0));
  if (d.source !== undefined && !SOURCES[d.source]) d.source = 'manuel';
  if (id) {
    if (d.stage_id) {
      const s = get('SELECT * FROM crm_stages WHERE id=?', d.stage_id);
      const cur = get('SELECT status FROM crm_leads WHERE id=?', id);
      if (s && d.probability === undefined) d.probability = s.probability;
      if (s?.is_won && cur?.status !== 'won') { d.status = 'won'; d.won_at = today(); }
      else if (s && !s.is_won && cur?.status === 'won') { d.status = 'open'; d.won_at = null; }
    }
    update('crm_leads', id, d, LEAD_COLS);
    run('UPDATE crm_leads SET updated_at=CURRENT_TIMESTAMP WHERE id=?', id);
    return id;
  }
  const st = firstStage();
  return insert('crm_leads', { stage_id: st.id, probability: st.probability, status: 'open', source: 'manuel', ...d }, LEAD_COLS);
}

/** Déplacer une carte dans le pipeline (glisser-déposer). L'étape « Gagné » marque l'opportunité gagnée. */
export function moveLead(id, stageId, sequence = 0) {
  const s = get('SELECT * FROM crm_stages WHERE id=?', stageId);
  if (!s) throw new BusinessError('Étape inconnue');
  run('UPDATE crm_leads SET stage_id=?, probability=?, sequence=?, status=?, won_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
    s.id, s.probability, sequence, s.is_won ? 'won' : 'open', s.is_won ? today() : null, id);
  return getLead(id);
}

export function markWon(id) {
  const won = get('SELECT id FROM crm_stages WHERE is_won=1 ORDER BY sequence LIMIT 1');
  return moveLead(id, won?.id || stages().at(-1).id);
}
export function markLost(id, reason) {
  run("UPDATE crm_leads SET status='lost', lost_reason=?, probability=0, updated_at=CURRENT_TIMESTAMP WHERE id=?", String(reason || 'Autre').slice(0, 120), id);
  return getLead(id);
}
export function restoreLead(id) {
  const st = firstStage();
  run("UPDATE crm_leads SET status='open', lost_reason=NULL, stage_id=?, probability=? WHERE id=?", st.id, st.probability, id);
  return getLead(id);
}

/** Crée (ou retrouve) le client correspondant à la piste. */
export function ensureCustomer(id) {
  const l = getLead(id);
  if (l.customer_id) return l.customer_id;
  let c = l.email ? get('SELECT id FROM customers WHERE lower(email)=lower(?)', l.email) : null;
  if (!c && l.phone) c = get("SELECT id FROM customers WHERE REPLACE(phone,' ','')=REPLACE(?,' ','') OR REPLACE(mobile,' ','')=REPLACE(?,' ','')", l.phone, l.phone);
  const cid = c?.id || insert('customers', { type: l.company ? 'societe' : 'particulier', name: l.contact_name || l.company || l.name, company: l.company, email: l.email, mobile: l.phone, notes: `Créé depuis le CRM (${SOURCES[l.source] || l.source})` },
    ['type', 'name', 'company', 'email', 'mobile', 'notes']);
  run('UPDATE crm_leads SET customer_id=? WHERE id=?', cid, id);
  return cid;
}

/** Nouveau devis depuis l'opportunité (comme « Nouveau devis » dans le CRM d'Odoo). */
export function createQuote(id) {
  return tx(() => {
    const l = getLead(id);
    if (l.quote_id) return l.quote_id;
    const customer_id = ensureCustomer(id);
    let vehicle_id = null;
    if (l.vehicle_plate) {
      const plate = l.vehicle_plate.toUpperCase().trim();
      vehicle_id = get("SELECT id FROM vehicles WHERE REPLACE(plate,' ','')=REPLACE(?,' ','')", plate)?.id
        || insert('vehicles', { customer_id, plate, model: l.vehicle_desc || null }, ['customer_id', 'plate', 'model']);
    }
    const docId = saveDocument({ type: 'quote', customer_id, vehicle_id, customer_complaint: [l.service, l.description].filter(Boolean).join(' — ') || l.name, lines: [] });
    const quote = get('SELECT id FROM crm_stages WHERE name LIKE ? ORDER BY sequence LIMIT 1', 'Devis%');
    run('UPDATE crm_leads SET quote_id=?, stage_id=COALESCE(?, stage_id), probability=MAX(probability, 60) WHERE id=?', docId, quote?.id ?? null, id);
    return docId;
  });
}

/** Chiffres du pipeline (comme l'analyse du CRM). */
export function pipelineStats() {
  const open = get("SELECT COUNT(*) n, COALESCE(SUM(expected_revenue),0) rev, COALESCE(SUM(expected_revenue*probability/100.0),0) weighted FROM crm_leads WHERE status='open'");
  const month = today().slice(0, 7);
  const won = get("SELECT COUNT(*) n, COALESCE(SUM(expected_revenue),0) rev FROM crm_leads WHERE status='won' AND substr(won_at,1,7)=?", month);
  const lostMonth = get("SELECT COUNT(*) n FROM crm_leads WHERE status='lost' AND substr(updated_at,1,7)=?", month).n;
  const closed = get("SELECT SUM(status='won') w, SUM(status='lost') l FROM crm_leads");
  const bySource = all("SELECT source, COUNT(*) n, SUM(status='won') won FROM crm_leads GROUP BY source ORDER BY n DESC");
  return {
    open: open.n, pipeline: round2(open.rev), weighted: round2(open.weighted), won_month: won.n, won_revenue_month: round2(won.rev), lost_month: lostMonth,
    win_rate: closed.w + closed.l ? Math.round((closed.w / (closed.w + closed.l)) * 100) : null,
    by_source: bySource.map((s) => ({ ...s, label: SOURCES[s.source] || s.source })),
  };
}

// Étapes du pipeline modifiables
export function saveStage(data, id = null) {
  const d = { name: String(data.name || '').slice(0, 60), probability: Math.min(100, Math.max(0, Number(data.probability) || 0)), is_won: data.is_won ? 1 : 0, sequence: Number(data.sequence) || 10 };
  if (!d.name) throw new BusinessError('Nom de l\'étape requis');
  if (id) { update('crm_stages', id, d, ['name', 'probability', 'is_won', 'sequence']); return id; }
  return insert('crm_stages', d, ['name', 'probability', 'is_won', 'sequence']);
}
export function deleteStage(id) {
  if (get('SELECT COUNT(*) n FROM crm_leads WHERE stage_id=?', id).n) throw new BusinessError('Déplacez d\'abord les opportunités de cette étape');
  if (get('SELECT COUNT(*) n FROM crm_stages').n <= 2) throw new BusinessError('Il faut garder au moins deux étapes');
  run('DELETE FROM crm_stages WHERE id=?', id);
}
