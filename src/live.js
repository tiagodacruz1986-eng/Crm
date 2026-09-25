// Suivi en direct des ordres de réparation :
// - lien mécanicien : photos/vidéos, messages, étapes, demandes d'accord ;
// - lien client : jauge d'avancement en temps réel, échanges, accord sur les travaux supplémentaires.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { db, all, get, run, insert, getSettings, round2, localDateTime, today } from './db.js';
import { BusinessError, refreshTotals } from './business.js';
import { logMessage, createActivity } from './mail.js';

const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.resolve('data'), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

db.exec(`
CREATE TABLE IF NOT EXISTS order_links (
  token TEXT PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  role TEXT NOT NULL, revoked INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS order_posts (
  id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author_role TEXT NOT NULL, author_name TEXT, body TEXT, media_file TEXT, media_type TEXT, media_name TEXT,
  public INTEGER DEFAULT 1, kind TEXT DEFAULT 'message', amount REAL, answer TEXT, answered_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_posts_doc ON order_posts(document_id);
`);
if (!all('PRAGMA table_info(documents)').some((c) => c.name === 'stage')) db.exec("ALTER TABLE documents ADD COLUMN stage TEXT DEFAULT 'received'");

export const STAGES = [
  { key: 'received', label: 'Véhicule reçu', icon: '🚗' },
  { key: 'diagnosis', label: 'Diagnostic', icon: '🔍' },
  { key: 'approval', label: 'Accord client', icon: '✍️' },
  { key: 'parts', label: 'Pièces', icon: '📦' },
  { key: 'repair', label: 'Réparation', icon: '🔧' },
  { key: 'quality', label: 'Contrôle qualité', icon: '✅' },
  { key: 'ready', label: 'Prêt à récupérer', icon: '🎉' },
];
const stageIndex = (k) => STAGES.findIndex((s) => s.key === k);

// ---------- Temps réel (Server-Sent Events) ----------
const listeners = new Map(); // documentId -> Set<res>
function subscribe(docId, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  if (!listeners.has(docId)) listeners.set(docId, new Set());
  listeners.get(docId).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => { clearInterval(ping); listeners.get(docId)?.delete(res); });
}
export function publish(docId, type = 'update') {
  for (const res of listeners.get(Number(docId)) || []) res.write(`data: ${JSON.stringify({ type, at: Date.now() })}\n\n`);
}

// ---------- Étapes ----------
export function setStage(docId, stage, by = 'Garage') {
  if (stageIndex(stage) < 0) throw new BusinessError('Étape inconnue');
  const d = get("SELECT id, stage, status FROM documents WHERE id=? AND type='order'", docId);
  if (!d) throw new BusinessError('OR introuvable', 404);
  if (d.stage === stage) return;
  run('UPDATE documents SET stage=? WHERE id=?', stage, docId);
  // Le statut de l'atelier suit l'étape
  if (d.status !== 'invoiced') {
    const status = { parts: 'waiting_parts', repair: 'in_progress', quality: 'in_progress', ready: 'done' }[stage];
    if (status) run('UPDATE documents SET status=? WHERE id=?', status, docId);
  }
  const s = STAGES[stageIndex(stage)];
  insert('order_posts', { document_id: docId, author_role: 'system', author_name: by, body: `${s.icon} Étape : ${s.label}`, kind: 'stage' }, ['document_id', 'author_role', 'author_name', 'body', 'kind']);
  logMessage('document', docId, `${s.icon} Étape du suivi client : ${s.label} (${by})`, null, 'system');
  publish(docId);
}
// Quand le statut change depuis l'atelier (Kanban, kiosque), la jauge avance si besoin
export function stageFromStatus(docId, status) {
  const target = { waiting_parts: 'parts', done: 'ready' }[status];
  const d = get('SELECT stage FROM documents WHERE id=?', docId);
  if (target && d && stageIndex(target) > stageIndex(d.stage || 'received')) setStage(docId, target, 'Atelier');
  else publish(docId);
}

// ---------- Liens ----------
export function getLinks(docId) {
  return all('SELECT token, role, created_at, last_seen FROM order_links WHERE document_id=? AND revoked=0', docId);
}
export function ensureLink(docId, role) {
  if (!['mechanic', 'customer'].includes(role)) throw new BusinessError('Rôle inconnu');
  if (!get("SELECT id FROM documents WHERE id=? AND type='order'", docId)) throw new BusinessError('OR introuvable', 404);
  const cur = get('SELECT token FROM order_links WHERE document_id=? AND role=? AND revoked=0', docId, role);
  if (cur) return cur.token;
  const token = crypto.randomBytes(18).toString('base64url');
  insert('order_links', { token, document_id: docId, role }, ['token', 'document_id', 'role']);
  return token;
}
export function revokeLink(docId, role) {
  run('UPDATE order_links SET revoked=1 WHERE document_id=? AND role=?', docId, role);
}
export function publicUrl(req) {
  const base = getSettings().public_url;
  return (base || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

// ---------- Fil d'échanges ----------
export function feed(docId, role) {
  const d = get(`SELECT d.id, d.number, d.stage, d.status, d.promised_at, d.customer_complaint, d.diagnosis, d.mileage,
      v.plate, v.make, v.model, c.name AS customer_name, u.name AS mechanic_name
    FROM documents d LEFT JOIN vehicles v ON v.id=d.vehicle_id LEFT JOIN customers c ON c.id=d.customer_id LEFT JOIN users u ON u.id=d.mechanic_id
    WHERE d.id=? AND d.type='order'`, docId);
  if (!d) throw new BusinessError('OR introuvable', 404);
  const posts = all(`SELECT id, author_role, author_name, body, media_type, media_name, public, kind, amount, answer, answered_at, created_at
    FROM order_posts WHERE document_id=? ${role === 'customer' ? 'AND public=1' : ''} ORDER BY id`, docId);
  const s = getSettings();
  const out = {
    order: role === 'customer' ? { ...d, diagnosis: undefined, mechanic_name: d.mechanic_name?.split(' ')[0] } : d,
    stages: STAGES, stage_index: Math.max(0, stageIndex(d.stage || 'received')), posts,
    garage: { name: s.company.name, phone: s.company.phone, email: s.company.email, address: [s.company.address, [s.company.zip, s.company.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') },
    role,
  };
  if (role !== 'customer') out.lines = all("SELECT id, kind, description, quantity, done FROM document_lines WHERE document_id=? AND kind!='text' ORDER BY sequence", docId);
  return out;
}

export function addPost(docId, { role, name, body, isPublic = true, kind = 'message', amount, file }) {
  if (!body?.trim() && !file) throw new BusinessError('Message vide');
  if (kind === 'approval' && !(Number(amount) > 0)) throw new BusinessError('Indiquez le montant TTC des travaux proposés');
  const d = get("SELECT id, status FROM documents WHERE id=? AND type='order'", docId);
  if (!d) throw new BusinessError('OR introuvable', 404);
  const id = insert('order_posts', {
    document_id: docId, author_role: role, author_name: name, body: body?.trim() || null, public: role === 'customer' || kind === 'approval' ? 1 : isPublic ? 1 : 0,
    kind, amount: kind === 'approval' ? round2(amount) : null, media_file: file?.file, media_type: file?.type, media_name: file?.name,
  }, ['document_id', 'author_role', 'author_name', 'body', 'public', 'kind', 'amount', 'media_file', 'media_type', 'media_name']);
  if (role === 'customer') {
    logMessage('document', docId, `💬 Message du client : ${body?.trim() || (file ? `[${file.type === 'video' ? 'vidéo' : 'photo'}]` : '')}`, null, 'system');
  } else if (kind === 'approval') {
    logMessage('document', docId, `✍️ Accord demandé au client : ${body} (${round2(amount).toFixed(2)} € TTC)`, null, 'system');
    const stage = get('SELECT stage FROM documents WHERE id=?', docId).stage;
    if (stageIndex(stage) < stageIndex('approval')) setStage(docId, 'approval', name);
  }
  publish(docId);
  return id;
}

export function answerApproval(docId, postId, answer) {
  if (!['accepted', 'refused'].includes(answer)) throw new BusinessError('Réponse invalide');
  const p = get("SELECT * FROM order_posts WHERE id=? AND document_id=? AND kind='approval'", postId, docId);
  if (!p) throw new BusinessError('Demande introuvable', 404);
  if (p.answer) throw new BusinessError('Vous avez déjà répondu à cette demande');
  run('UPDATE order_posts SET answer=?, answered_at=? WHERE id=?', answer, localDateTime(), postId);
  const ok = answer === 'accepted';
  if (ok) {
    // Les travaux acceptés sont ajoutés automatiquement à l'OR
    const tax = getSettings().workshop.default_tax;
    const seq = get('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM document_lines WHERE document_id=?', docId).n;
    insert('document_lines', { document_id: docId, sequence: seq, kind: 'fee', description: `Accepté par le client : ${p.body}`, quantity: 1, unit_price: round2(p.amount / (1 + tax / 100)), tax_rate: tax, total_ht: round2(p.amount / (1 + tax / 100)) },
      ['document_id', 'sequence', 'kind', 'description', 'quantity', 'unit_price', 'tax_rate', 'total_ht']);
    refreshTotals(docId);
  }
  insert('order_posts', { document_id: docId, author_role: 'customer', author_name: 'Client', body: `${ok ? '✅ J\'accepte' : '❌ Je refuse'} : ${p.body} (${p.amount.toFixed(2)} € TTC)`, kind: 'answer' }, ['document_id', 'author_role', 'author_name', 'body', 'kind']);
  logMessage('document', docId, `${ok ? '✅ Le client a ACCEPTÉ' : '❌ Le client a REFUSÉ'} : ${p.body} (${p.amount.toFixed(2)} € TTC)${ok ? ' — ligne ajoutée à l\'OR' : ''}`, null, 'system');
  const admin = get("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1");
  if (admin) createActivity({ model: 'document', record_id: docId, type: 'todo', summary: `Client ${ok ? 'a accepté' : 'a refusé'} : ${p.body}`, due_date: today() }, admin.id);
  publish(docId);
}

// ---------- Fichiers ----------
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp' };
function saveUpload(docId, req) {
  const mime = (req.headers['content-type'] || '').split(';')[0].toLowerCase();
  const ext = EXT[mime];
  if (!ext) throw new BusinessError('Format non accepté (photos JPG/PNG/HEIC, vidéos MP4/MOV/WEBM)');
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new BusinessError('Fichier vide');
  const dir = path.join(UPLOAD_DIR, String(docId));
  fs.mkdirSync(dir, { recursive: true });
  const file = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, file), req.body);
  return { file: `${docId}/${file}`, type: mime.startsWith('video') ? 'video' : 'image', name: decodeURIComponent(req.headers['x-filename'] || file).slice(0, 120) };
}
function sendMedia(res, docId, postId, role) {
  const p = get(`SELECT media_file FROM order_posts WHERE id=? AND document_id=? ${role === 'customer' ? 'AND public=1' : ''}`, postId, docId);
  if (!p?.media_file) return res.status(404).end();
  const full = path.resolve(UPLOAD_DIR, p.media_file);
  if (!full.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return res.status(404).end();
  res.sendFile(full, { headers: { 'Cache-Control': 'private, max-age=86400' } });
}

// ---------- Routes ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).then((r) => { if (r !== undefined && !res.headersSent) res.json(r); }).catch(next);
const raw = express.raw({ type: () => true, limit: '300mb' });

export function mountLive(app, api) {
  // Accès public par lien (mécanicien ou client)
  const pub = express.Router();
  const byToken = (req) => {
    const l = get('SELECT * FROM order_links WHERE token=? AND revoked=0', req.params.token);
    if (!l) throw new BusinessError('Ce lien n\'est plus valide. Contactez le garage.', 404);
    run('UPDATE order_links SET last_seen=? WHERE token=?', localDateTime(), l.token);
    return l;
  };
  pub.get('/:token', wrap((req) => { const l = byToken(req); return feed(l.document_id, l.role); }));
  pub.get('/:token/events', (req, res, next) => { try { subscribe(byToken(req).document_id, res); } catch (e) { next(e); } });
  pub.get('/:token/media/:post', (req, res, next) => { try { const l = byToken(req); sendMedia(res, l.document_id, Number(req.params.post), l.role); } catch (e) { next(e); } });
  pub.post('/:token/posts', express.json(), wrap((req) => {
    const l = byToken(req);
    const name = l.role === 'customer' ? 'Client' : req.body.name || 'Mécanicien';
    return { id: addPost(l.document_id, { role: l.role, name, body: req.body.body, isPublic: req.body.public !== false, kind: l.role === 'mechanic' && req.body.kind === 'approval' ? 'approval' : 'message', amount: req.body.amount }) };
  }));
  pub.post('/:token/upload', raw, wrap((req) => {
    const l = byToken(req);
    const file = saveUpload(l.document_id, req);
    return { id: addPost(l.document_id, { role: l.role, name: l.role === 'customer' ? 'Client' : decodeURIComponent(req.headers['x-author'] || 'Mécanicien'), body: decodeURIComponent(req.headers['x-caption'] || ''), isPublic: req.headers['x-public'] !== '0', file }) };
  }));
  pub.post('/:token/stage', express.json(), wrap((req) => {
    const l = byToken(req);
    if (l.role !== 'mechanic') throw new BusinessError('Accès refusé', 403);
    setStage(l.document_id, req.body.stage, req.body.name || 'Mécanicien');
    return { ok: true };
  }));
  pub.post('/:token/lines/:line', express.json(), wrap((req) => {
    const l = byToken(req);
    if (l.role !== 'mechanic') throw new BusinessError('Accès refusé', 403);
    run('UPDATE document_lines SET done=? WHERE id=? AND document_id=?', req.body.done ? 1 : 0, req.params.line, l.document_id);
    publish(l.document_id);
    return { ok: true };
  }));
  pub.post('/:token/posts/:post/answer', express.json(), wrap((req) => {
    const l = byToken(req);
    if (l.role !== 'customer') throw new BusinessError('Seul le client peut répondre', 403);
    answerApproval(l.document_id, Number(req.params.post), req.body.answer);
    return { ok: true };
  }));
  app.use('/live-api', pub);

  // Accès bureau (connecté)
  api.get('/live/:id', wrap((req) => {
    const id = Number(req.params.id);
    const base = publicUrl(req);
    return { ...feed(id, 'office'), links: getLinks(id).map((l) => ({ ...l, url: `${base}/suivi.html?t=${l.token}` })), public_url: getSettings().public_url || null };
  }));
  api.get('/live/:id/events', (req, res) => subscribe(Number(req.params.id), res));
  api.get('/live/:id/media/:post', (req, res) => sendMedia(res, Number(req.params.id), Number(req.params.post), 'office'));
  api.post('/live/:id/links', wrap((req) => ({ token: ensureLink(Number(req.params.id), req.body.role) })));
  api.delete('/live/:id/links/:role', wrap((req) => { revokeLink(Number(req.params.id), req.params.role); return { ok: true }; }));
  api.post('/live/:id/stage', wrap((req) => { setStage(Number(req.params.id), req.body.stage, req.user.name); return { ok: true }; }));
  api.post('/live/:id/posts', wrap((req) => ({ id: addPost(Number(req.params.id), { role: 'office', name: req.user.name, body: req.body.body, isPublic: req.body.public !== false, kind: req.body.kind === 'approval' ? 'approval' : 'message', amount: req.body.amount }) })));
  api.post('/live/:id/upload', raw, wrap((req) => {
    const id = Number(req.params.id);
    return { id: addPost(id, { role: 'office', name: req.user.name, body: decodeURIComponent(req.headers['x-caption'] || ''), isPublic: req.headers['x-public'] !== '0', file: saveUpload(id, req) }) };
  }));
}
