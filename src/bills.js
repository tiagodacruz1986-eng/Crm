// Factures fournisseurs : réception par e-mail (boîte IMAP dédiée) ou dépôt de fichier,
// encodage automatique par l'IA et conservation du document original en pièce jointe (comme Odoo).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db, all, get, run, insert, getSettings, setSetting, round2, localDateTime, today } from './db.js';
import { BusinessError, savePurchase } from './business.js';
import { logMessage } from './mail.js';
import { aiConfigured } from './claude.js';

const FILE_DIR = path.join(process.env.DATA_DIR || path.resolve('data'), 'uploads', 'attachments');
fs.mkdirSync(FILE_DIR, { recursive: true });

db.exec(`
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY, model TEXT NOT NULL, record_id INTEGER NOT NULL, filename TEXT, mime TEXT, path TEXT NOT NULL,
  size INTEGER, source TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_attachments_rec ON attachments(model, record_id);
CREATE TABLE IF NOT EXISTS bill_emails (message_id TEXT PRIMARY KEY, sender TEXT, subject TEXT, result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
{
  const cols = all('PRAGMA table_info(purchases)').map((c) => c.name);
  for (const [c, t] of [['source', "TEXT DEFAULT 'manual'"], ['review', 'TEXT'], ['ai_total', 'REAL'], ['ai_notes', 'TEXT'], ['email_from', 'TEXT']]) {
    if (!cols.includes(c)) db.exec(`ALTER TABLE purchases ADD COLUMN ${c} ${t}`);
  }
}

// ---------- Pièces jointes ----------
const SUPPORTED = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
export function saveAttachment(model, recordId, { buffer, mime, filename, source }) {
  const ext = SUPPORTED[mime] || (filename?.split('.').pop() || 'bin').slice(0, 5);
  const rel = `${model}-${recordId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(FILE_DIR, rel), buffer);
  return insert('attachments', { model, record_id: recordId, filename: filename || rel, mime, path: rel, size: buffer.length, source },
    ['model', 'record_id', 'filename', 'mime', 'path', 'size', 'source']);
}
export const listAttachments = (model, recordId) => all('SELECT id, filename, mime, size, source, created_at FROM attachments WHERE model=? AND record_id=? ORDER BY id', model, recordId);
export function attachmentFile(id) {
  const a = get('SELECT * FROM attachments WHERE id=?', id);
  if (!a) return null;
  const full = path.resolve(FILE_DIR, a.path);
  return full.startsWith(path.resolve(FILE_DIR) + path.sep) && fs.existsSync(full) ? { ...a, full } : null;
}
export function deleteAttachment(id) {
  const a = attachmentFile(id);
  if (a) fs.rmSync(a.full, { force: true });
  run('DELETE FROM attachments WHERE id=?', id);
}

// ---------- Extraction par l'IA ----------
const nul = (type) => ({ anyOf: [{ type }, { type: 'null' }] });
const BILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_invoice', 'is_credit_note', 'supplier', 'invoice_number', 'invoice_date', 'due_date', 'currency', 'lines', 'total_ht', 'total_tax', 'total_ttc', 'remarks'],
  properties: {
    is_invoice: { type: 'boolean', description: 'true si le document est bien une facture ou un avoir fournisseur' },
    is_credit_note: { type: 'boolean' },
    supplier: {
      type: 'object', additionalProperties: false,
      required: ['name', 'vat_number', 'iban', 'email', 'phone', 'address', 'zip', 'city', 'country'],
      properties: { name: { type: 'string' }, vat_number: nul('string'), iban: nul('string'), email: nul('string'), phone: nul('string'), address: nul('string'), zip: nul('string'), city: nul('string'), country: nul('string') },
    },
    invoice_number: nul('string'),
    invoice_date: { ...nul('string'), description: 'AAAA-MM-JJ' },
    due_date: { ...nul('string'), description: 'AAAA-MM-JJ' },
    currency: { type: 'string' },
    lines: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['description', 'reference', 'quantity', 'unit_price_ht', 'tax_rate', 'total_ht', 'account_code'],
        properties: {
          description: { type: 'string' }, reference: nul('string'), quantity: { type: 'number' },
          unit_price_ht: { type: 'number', description: 'prix unitaire HT après remise' }, tax_rate: { type: 'number' },
          total_ht: { type: 'number' }, account_code: { type: 'string' },
        },
      },
    },
    total_ht: nul('number'), total_tax: nul('number'), total_ttc: nul('number'),
    remarks: { type: 'string', description: 'points à vérifier par le comptable, vide si rien' },
  },
};

let client = null;
export async function extractBill(buffer, mime) {
  if (!SUPPORTED[mime]) throw new BusinessError('Format non pris en charge par l\'IA (PDF, JPG, PNG, WEBP)');
  client ??= new Anthropic();
  const accounts = all("SELECT code, name FROM accounts WHERE type='expense' OR code LIKE '2%' ORDER BY code").map((a) => `${a.code} ${a.name}`).join('\n');
  const source = { type: 'base64', media_type: mime, data: buffer.toString('base64') };
  const doc = mime === 'application/pdf' ? { type: 'document', source } : { type: 'image', source };
  const response = await client.messages.parse({
    model: process.env.CLAUDE_MODEL || 'claude-opus-5',
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: [doc, {
        type: 'text',
        text: `Tu es comptable dans un garage automobile au Luxembourg. Encode cette facture fournisseur.
Règles :
- Montants en nombres (point décimal). unit_price_ht = prix unitaire HORS TVA après remise ; si seul le TTC est indiqué, calcule le HT.
- tax_rate : taux de TVA de la ligne (Luxembourg : 17, 14, 8, 3 ou 0 ; autre pays : le taux indiqué, 0 si autoliquidation intracommunautaire).
- reference : référence article du fournisseur si présente.
- account_code : choisis dans ce plan comptable le compte de charge le plus adapté (6070 pour les pièces et marchandises revendues aux clients) :
${accounts}
- Une ligne par article. Les frais de port/transport sont une ligne séparée.
- Dates au format AAAA-MM-JJ. Si l'échéance n'est pas indiquée, null.
- remarks : signale en français tout doute (montant illisible, total incohérent, document qui n'est pas une facture…).`,
      }],
    }],
    output_config: { format: jsonSchemaOutputFormat(BILL_SCHEMA) },
  });
  if (response.stop_reason === 'refusal') throw new BusinessError('L\'IA n\'a pas pu analyser ce document');
  if (!response.parsed_output) throw new BusinessError('Réponse de l\'IA illisible');
  return response.parsed_output;
}

// ---------- Rapprochement fournisseur / articles ----------
const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function findSupplier(s, emailFrom) {
  if (s?.vat_number) { const r = all('SELECT id, vat_number FROM suppliers WHERE vat_number IS NOT NULL').find((x) => norm(x.vat_number) === norm(s.vat_number)); if (r) return r.id; }
  if (s?.iban) { const r = all('SELECT id, iban FROM suppliers WHERE iban IS NOT NULL').find((x) => norm(x.iban) === norm(s.iban)); if (r) return r.id; }
  const email = (s?.email || emailFrom || '').toLowerCase();
  if (email) { const r = get('SELECT id FROM suppliers WHERE lower(email)=?', email); if (r) return r.id; }
  if (s?.name) {
    const n = norm(s.name).replace(/(SARL|SA|SAS|SRL|GMBH|SCS|SASU|LTD|BV|NV)$/g, '');
    const r = all('SELECT id, name FROM suppliers').find((x) => { const m = norm(x.name).replace(/(SARL|SA|SAS|SRL|GMBH|SCS|SASU|LTD|BV|NV)$/g, ''); return m && n && (m === n || (m.length > 5 && n.startsWith(m)) || (n.length > 5 && m.startsWith(n))); });
    if (r) return r.id;
  }
  return null;
}
function findProduct(ref, supplierId) {
  if (!ref) return null;
  const r = norm(ref);
  if (r.length < 3) return null;
  const all_ = all('SELECT id, ref, ean, supplier_id FROM products WHERE active=1 AND (ref IS NOT NULL OR ean IS NOT NULL)');
  return (all_.find((p) => norm(p.ref) === r && p.supplier_id === supplierId) || all_.find((p) => norm(p.ref) === r || norm(p.ean) === r))?.id || null;
}
const validDate = (d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);

// ---------- Création de la facture fournisseur ----------
async function analyze(buffer, mime) {
  if (!aiConfigured()) return { data: null, aiError: 'Encodage IA indisponible (clé API Claude non configurée)' };
  if (!SUPPORTED[mime]) return { data: null, aiError: 'Format non lisible par l\'IA' };
  try { return { data: await extractBill(buffer, mime), aiError: null }; } catch (e) { return { data: null, aiError: e.message }; }
}

// Transforme les données extraites en facture fournisseur (création ou mise à jour d'un brouillon)
function applyExtraction(purchaseId, data, { aiError, emailFrom, emailSubject, source }) {
  const warnings = [];
  let supplierId = findSupplier(data?.supplier, emailFrom);
  if (!supplierId && data?.supplier?.name) {
    const s = data.supplier;
    supplierId = insert('suppliers', { name: s.name, vat_number: s.vat_number, iban: s.iban, email: s.email || emailFrom, phone: s.phone, address: s.address, zip: s.zip, city: s.city, country: s.country || 'LU', notes: 'Créé automatiquement depuis une facture reçue' },
      ['name', 'vat_number', 'iban', 'email', 'phone', 'address', 'zip', 'city', 'country', 'notes']);
    warnings.push(`Nouveau fournisseur créé : ${s.name}`);
  }
  if (data && !data.is_invoice) warnings.push('⚠ Le document ne semble pas être une facture.');
  if (data?.is_credit_note) warnings.push('⚠ Il s\'agit d\'un AVOIR fournisseur : vérifiez le traitement avant de comptabiliser.');
  if (data?.currency && data.currency.toUpperCase() !== 'EUR') warnings.push(`⚠ Devise ${data.currency} : montants à convertir en euros.`);
  if (data?.invoice_number && supplierId) {
    const dup = get('SELECT number FROM purchases WHERE supplier_id=? AND supplier_ref=? AND id!=?', supplierId, data.invoice_number, purchaseId || 0);
    if (dup) warnings.push(`⚠ Doublon possible : la facture ${data.invoice_number} existe déjà (${dup.number}).`);
  }
  const validAccounts = new Set(all('SELECT code FROM accounts').map((a) => a.code));
  const lines = (data?.lines || []).map((l) => ({
    product_id: findProduct(l.reference, supplierId),
    description: [l.reference, l.description].filter(Boolean).join(' — ').slice(0, 250),
    quantity: l.quantity || 1, unit_price: round2(l.unit_price_ht), tax_rate: l.tax_rate ?? 17,
    account_code: validAccounts.has(l.account_code) ? l.account_code : null,
  }));
  if (data?.remarks?.trim()) warnings.push(`IA : ${data.remarks.trim()}`);
  if (aiError) warnings.push(`⚠ ${aiError}`);
  const origin = emailFrom ? `Reçue par e-mail de ${emailFrom}${emailSubject ? ` (« ${emailSubject} »)` : ''}` : 'Déposée dans le logiciel';
  const id = savePurchase({
    supplier_id: supplierId, date: validDate(data?.invoice_date) || today(), due_date: validDate(data?.due_date),
    supplier_ref: data?.invoice_number || null, notes: origin, ...(data || !purchaseId ? { lines } : {}),
  }, purchaseId);
  const p = get('SELECT total FROM purchases WHERE id=?', id);
  if (data?.total_ttc != null && Math.abs(p.total - data.total_ttc) > 0.05) warnings.push(`⚠ Total calculé ${p.total.toFixed(2)} € ≠ total de la facture ${Number(data.total_ttc).toFixed(2)} € : vérifiez les lignes.`);
  run("UPDATE purchases SET source=?, review='to_review', ai_total=?, ai_notes=?, email_from=? WHERE id=?",
    source, data?.total_ttc ?? null, warnings.join('\n') || null, emailFrom, id);
  return { id, warnings };
}

export async function createBillFromFile({ buffer, mime, filename, source = 'upload', emailFrom = null, emailSubject = null }) {
  if (!buffer?.length) throw new BusinessError('Fichier vide');
  const { data, aiError } = await analyze(buffer, mime);
  const { id, warnings } = applyExtraction(null, data, { aiError, emailFrom, emailSubject, source });
  saveAttachment('purchase', id, { buffer, mime, filename, source });
  logMessage('purchase', id, `📥 Facture ${source === 'email' ? `reçue par e-mail${emailFrom ? ` de ${emailFrom}` : ''}` : 'déposée'} : ${filename || 'document'}${data ? ' — encodée automatiquement par l\'IA' : ''}`, null, 'system');
  return { id, warnings, extracted: Boolean(data) };
}

// Relance l'IA sur le document original d'une facture encore en brouillon
export async function reanalyze(purchaseId) {
  const p = get('SELECT * FROM purchases WHERE id=?', purchaseId);
  if (!p) throw new BusinessError('Facture introuvable', 404);
  if (p.posted) throw new BusinessError('Facture déjà comptabilisée');
  const a = listAttachments('purchase', purchaseId).map((x) => attachmentFile(x.id)).find((x) => x && SUPPORTED[x.mime]);
  if (!a) throw new BusinessError('Aucun document PDF ou image à analyser');
  const { data, aiError } = await analyze(fs.readFileSync(a.full), a.mime);
  if (!data) throw new BusinessError(aiError);
  const r = applyExtraction(purchaseId, data, { aiError, emailFrom: p.email_from, source: p.source || 'upload' });
  logMessage('purchase', purchaseId, '🔄 Facture ré-encodée par l\'IA', null, 'system');
  return { id: purchaseId, warnings: r.warnings, extracted: true };
}

// ---------- Boîte e-mail dédiée (IMAP) ----------
export function inboxConfig() { return getSettings().bills_inbox || {}; }
export function publicInboxConfig() { const { pass, ...c } = inboxConfig(); return { ...c, has_pass: Boolean(pass), status: getSettings().bills_inbox_status || null }; }
export function saveInboxConfig(c) {
  const cur = inboxConfig();
  setSetting('bills_inbox', {
    enabled: Boolean(c.enabled ?? cur.enabled), host: (c.host ?? cur.host ?? '').trim(), port: Number(c.port ?? cur.port ?? 993),
    secure: c.secure ?? cur.secure ?? true, user: (c.user ?? cur.user ?? '').trim(), pass: c.pass ? c.pass : cur.pass,
    folder: (c.folder ?? cur.folder ?? 'INBOX').trim() || 'INBOX', processed_folder: (c.processed_folder ?? cur.processed_folder ?? '').trim(),
    interval: Math.max(1, Number(c.interval ?? cur.interval ?? 5)),
  });
}
function imapClient() {
  const c = inboxConfig();
  if (!c.host || !c.user || !c.pass) throw new BusinessError('Renseignez le serveur IMAP, l\'identifiant et le mot de passe de la boîte « factures ».');
  return new ImapFlow({ host: c.host, port: c.port, secure: c.secure !== false, auth: { user: c.user, pass: c.pass }, logger: false, socketTimeout: 60000 });
}
export async function testInbox() {
  const cl = imapClient();
  try {
    await cl.connect();
    const st = await cl.status(inboxConfig().folder || 'INBOX', { messages: true, unseen: true });
    return { messages: st.messages, unseen: st.unseen };
  } catch (e) {
    throw new BusinessError(`Connexion à la boîte impossible : ${e.responseText || e.message}`);
  } finally { await cl.logout().catch(() => {}); }
}

// Traite un e-mail brut : chaque PDF / image joint devient une facture fournisseur en brouillon
export async function processRawEmail(raw) {
  const mail = await simpleParser(raw);
  const messageId = mail.messageId || crypto.createHash('sha1').update(raw).digest('hex');
  if (get('SELECT 1 FROM bill_emails WHERE message_id=?', messageId)) return { skipped: true, created: [] };
  const from = mail.from?.value?.[0]?.address || null;
  const files = (mail.attachments || []).filter((a) => SUPPORTED[a.contentType?.toLowerCase()] && !(a.contentType.startsWith('image/') && a.size < 15000)); // ignore les logos de signature
  const created = [];
  for (const f of files) created.push(await createBillFromFile({ buffer: f.content, mime: f.contentType.toLowerCase(), filename: f.filename || 'facture', source: 'email', emailFrom: from, emailSubject: mail.subject }));
  insert('bill_emails', { message_id: messageId, sender: from, subject: mail.subject, result: created.length ? `${created.length} facture(s)` : 'aucune pièce jointe exploitable' }, ['message_id', 'sender', 'subject', 'result']);
  return { skipped: false, created, from, subject: mail.subject };
}

let checking = false;
export async function checkInbox() {
  if (checking) throw new BusinessError('Vérification déjà en cours');
  checking = true;
  const status = { at: localDateTime(), emails: 0, bills: 0, error: null };
  const c = inboxConfig();
  const cl = imapClient();
  try {
    await cl.connect();
    const lock = await cl.getMailboxLock(c.folder || 'INBOX');
    try {
      const uids = (await cl.search({ seen: false }, { uid: true })) || [];
      for (const uid of uids.slice(0, 50)) {
        const msg = await cl.fetchOne(uid, { source: true }, { uid: true });
        const r = await processRawEmail(msg.source);
        status.emails++;
        status.bills += r.created.length;
        await cl.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        if (c.processed_folder) await cl.messageMove(uid, c.processed_folder, { uid: true }).catch(() => {});
      }
    } finally { lock.release(); }
  } catch (e) {
    status.error = e instanceof BusinessError ? e.message : `${e.responseText || e.message}`;
  } finally {
    checking = false;
    await cl.logout().catch(() => {});
    setSetting('bills_inbox_status', status);
  }
  if (status.error) throw new BusinessError(status.error);
  return status;
}

export function startInboxPolling() {
  setInterval(() => {
    const c = inboxConfig();
    if (!c.enabled || checking) return;
    const last = getSettings().bills_inbox_status?.at;
    if (last && Date.now() - new Date(last).getTime() < c.interval * 60000) return;
    checkInbox().catch((e) => console.error('Boîte factures :', e.message));
  }, 60_000);
}
