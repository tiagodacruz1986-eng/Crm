process.env.TZ ||= 'Europe/Luxembourg';

import express from 'express';
import path from 'node:path';
import os from 'node:os';
import QRCode from 'qrcode';
import { all, get, run, insert, update, tx, today, getSettings, setSetting, round2, localDateTime } from './src/db.js';
import { hashSecret, verifySecret, createSession, currentUser, requireAuth } from './src/auth.js';
import {
  BusinessError, createMove, getDocument, saveDocument, convertDocument, postInvoice, registerPayment, addStockMove,
  getPurchase, savePurchase, receivePurchase, postPurchase, dashboard, trialBalance, vatReport, profitAndLoss, durationHours,
} from './src/business.js';
import { parseCamt, parseCsv, importLines, suggestions, matchLine, assignLine, autoReconcile, syncAccount, PROVIDERS } from './src/bank.js';
import { AGENTS } from './src/agents.js';
import {
  MODELS, MODULES, ACTIVITY_TYPES, TEMPLATE_LABELS, publicMailConfig, saveMailConfig, testMail, compose, renderEmail, sendEmail, processScheduledEmails,
  logMessage, chatter, listActivities, createActivity, completeActivity, activityCounts, ACTIVITY_COLS, recordInfo,
} from './src/mail.js';
import { runAgent, friendlyError } from './src/claude.js';
import {
  createBillFromFile, reanalyze, listAttachments, attachmentFile, deleteAttachment, saveAttachment, publicInboxConfig, saveInboxConfig, testInbox, checkInbox, startInboxPolling,
} from './src/bills.js';
import { mountLive, stageFromStatus, ensureLink, publicUrl, publish as livePublish } from './src/live.js';
import { publicOdooConfig, saveOdooConfig, testConnection, runImport, job as odooJob } from './src/odoo.js';
import { chat, meeting, clearHistory, aiConfigured } from './src/claude.js';
import { startScheduler, computeNextRun, executeTask, running } from './src/scheduler.js';

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '20mb' }));
app.use(express.text({ type: ['text/*', 'application/xml'], limit: '20mb' }));

// Fichiers statiques + librairies locales (fonctionne sans internet)
const nm = (p) => path.resolve('node_modules', p);
app.use('/vendor/vue.js', express.static(nm('vue/dist/vue.esm-browser.prod.js')));
app.use('/vendor/marked.js', express.static(nm('marked/lib/marked.esm.js')));
app.use('/vendor/purify.js', express.static(nm('dompurify/dist/purify.es.mjs')));
app.use('/vendor/three', express.static(nm('three')));
app.use(express.static(path.resolve('public')));

const api = express.Router();
app.use('/api', api);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).then((r) => { if (r !== undefined && !res.headersSent) res.json(r); }).catch(next);
const staff = requireAuth(['admin', 'office']);
const adminOnly = requireAuth(['admin']);

// ---------- Authentification ----------
api.get('/auth/status', (req, res) => {
  const needsSetup = get('SELECT COUNT(*) n FROM users WHERE role=?', 'admin').n === 0;
  res.json({ needsSetup, user: currentUser(req), company: getSettings().company.name, ai: aiConfigured() });
});
api.post('/auth/setup', wrap((req, res) => {
  if (get("SELECT COUNT(*) n FROM users WHERE role='admin'").n > 0) throw new BusinessError('Déjà configuré', 403);
  const { name, email, password, company } = req.body;
  if (!name || !email || !password || password.length < 6) throw new BusinessError('Nom, e-mail et mot de passe (6 caractères min.) requis');
  const id = insert('users', { name, email: email.toLowerCase(), role: 'admin', password_hash: hashSecret(password) }, ['name', 'email', 'role', 'password_hash']);
  if (company) setSetting('company', { ...getSettings().company, name: company });
  const token = createSession(id);
  res.cookie('gsession', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400e3 });
  return { token };
}));
api.post('/auth/login', wrap((req, res) => {
  const u = get('SELECT * FROM users WHERE email=? AND active=1', String(req.body.email || '').toLowerCase());
  if (!u || !verifySecret(req.body.password || '', u.password_hash)) throw new BusinessError('Identifiants incorrects', 401);
  const token = createSession(u.id);
  res.cookie('gsession', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400e3 });
  return { token };
}));
api.post('/auth/logout', (req, res) => {
  const u = currentUser(req);
  if (u) run('DELETE FROM sessions WHERE token=?', u.token);
  res.clearCookie('gsession');
  res.json({ ok: true });
});

// ---------- Kiosque mécaniciens (pointage) ----------
api.get('/kiosk/users', (req, res) => res.json(all("SELECT id, name, color FROM users WHERE active=1 AND role='mechanic' AND pin_hash IS NOT NULL ORDER BY name")));
api.post('/kiosk/login', wrap((req) => {
  const u = get("SELECT * FROM users WHERE id=? AND active=1 AND role='mechanic'", req.body.user_id);
  if (!u || !verifySecret(req.body.pin || '', u.pin_hash)) throw new BusinessError('Code PIN incorrect', 401);
  return { token: createSession(u.id, 'kiosk'), user: { id: u.id, name: u.name, color: u.color } };
}));
const mech = requireAuth(['mechanic', 'admin', 'office']);
function kioskState(userId) {
  const presence = get("SELECT * FROM time_entries WHERE user_id=? AND kind='presence' AND end IS NULL", userId);
  const work = get(`SELECT t.*, d.number, v.plate FROM time_entries t LEFT JOIN documents d ON d.id=t.document_id LEFT JOIN vehicles v ON v.id=d.vehicle_id
    WHERE t.user_id=? AND t.kind='work' AND t.end IS NULL`, userId);
  const orders = all(`SELECT d.id, d.number, d.status, d.customer_complaint, d.diagnosis, d.promised_at, d.mechanic_id, v.plate, v.make, v.model, v.vin, d.mileage,
      c.name AS customer_name FROM documents d LEFT JOIN vehicles v ON v.id=d.vehicle_id LEFT JOIN customers c ON c.id=d.customer_id
    WHERE d.type='order' AND d.status IN ('open','in_progress','waiting_parts') ORDER BY (d.mechanic_id=?) DESC, d.promised_at, d.id`, userId);
  for (const o of orders) {
    o.lines = all("SELECT id, kind, description, quantity, done FROM document_lines WHERE document_id=? AND kind!='text' ORDER BY sequence", o.id);
    o.hours_spent = round2(all("SELECT * FROM time_entries WHERE document_id=? AND kind='work'", o.id).reduce((s, t) => s + durationHours(t), 0));
  }
  const dayStart = `${today()}T00:00:00`;
  const todayHours = round2(all("SELECT * FROM time_entries WHERE user_id=? AND kind='work' AND start>=?", userId, dayStart).reduce((s, t) => s + durationHours(t), 0));
  return { presence, work, orders, todayHours };
}
api.get('/kiosk/state', mech, (req, res) => res.json(kioskState(req.user.id)));
function stopWork(userId, now) {
  run("UPDATE time_entries SET end=? WHERE user_id=? AND kind='work' AND end IS NULL", now, userId);
}
api.post('/kiosk/clock', mech, wrap((req) => {
  const now = localDateTime();
  const uid = req.user.id;
  const { action, document_id, note } = req.body;
  tx(() => {
    const presence = get("SELECT id FROM time_entries WHERE user_id=? AND kind='presence' AND end IS NULL", uid);
    if (action === 'in') {
      if (!presence) insert('time_entries', { user_id: uid, kind: 'presence', start: now }, ['user_id', 'kind', 'start']);
    } else if (action === 'out') {
      stopWork(uid, now);
      run("UPDATE time_entries SET end=? WHERE user_id=? AND kind='presence' AND end IS NULL", now, uid);
    } else if (action === 'start') {
      if (!presence) insert('time_entries', { user_id: uid, kind: 'presence', start: now }, ['user_id', 'kind', 'start']);
      stopWork(uid, now);
      const d = get("SELECT id, status FROM documents WHERE id=? AND type='order'", document_id);
      if (!d) throw new BusinessError('OR introuvable');
      insert('time_entries', { user_id: uid, kind: 'work', document_id, start: now, note }, ['user_id', 'kind', 'document_id', 'start', 'note']);
      if (d.status === 'open') run("UPDATE documents SET status='in_progress', mechanic_id=COALESCE(mechanic_id, ?) WHERE id=?", uid, document_id);
    } else if (action === 'stop') {
      stopWork(uid, now);
    } else throw new BusinessError('Action inconnue');
  });
  return kioskState(uid);
}));
api.post('/kiosk/orders/:id', mech, wrap((req) => {
  const id = Number(req.params.id);
  const d = get("SELECT * FROM documents WHERE id=? AND type='order'", id);
  if (!d || d.status === 'invoiced') throw new BusinessError('OR non modifiable');
  const { line_id, done, diagnosis, status, mileage, note } = req.body;
  if (line_id !== undefined) run('UPDATE document_lines SET done=? WHERE id=? AND document_id=?', done ? 1 : 0, line_id, id);
  if (diagnosis !== undefined) run('UPDATE documents SET diagnosis=? WHERE id=?', diagnosis, id);
  if (mileage) { run('UPDATE documents SET mileage=? WHERE id=?', mileage, id); if (d.vehicle_id) run('UPDATE vehicles SET mileage=MAX(COALESCE(mileage,0),?) WHERE id=?', mileage, d.vehicle_id); }
  if (note) run("UPDATE documents SET internal_notes=COALESCE(internal_notes,'') || ? WHERE id=?", `\n[${req.user.name} ${localDateTime().slice(0, 16).replace('T', ' ')}] ${note}`, id);
  if (status && ['in_progress', 'waiting_parts', 'done'].includes(status)) {
    run('UPDATE documents SET status=? WHERE id=?', status, id);
    if (status === 'done') run("UPDATE time_entries SET end=? WHERE document_id=? AND kind='work' AND end IS NULL", localDateTime(), id);
    stageFromStatus(id, status);
  } else if (line_id !== undefined) livePublish(id);
  return kioskState(req.user.id);
}));
// Lien "photos & messages" du mécanicien pour un OR
api.post('/kiosk/orders/:id/live', mech, wrap((req) => ({ url: `/suivi.html?t=${ensureLink(Number(req.params.id), 'mechanic')}` })));

// ---------- Tout le reste nécessite une connexion bureau ----------
api.use((req, res, next) => (req.path.startsWith('/kiosk') || req.path.startsWith('/auth') ? next() : staff(req, res, next)));

api.get('/dashboard', (req, res) => res.json(dashboard()));
// Adresses du PC sur le réseau local (pour ouvrir le logiciel sur téléphone / tablette)
api.get('/network', (req, res) => {
  const port = req.get('host')?.split(':')[1] || process.env.PORT || 3000;
  const urls = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map((i) => `http://${i.address}:${port}/`);
  const pub = getSettings().public_url;
  res.json({ urls: pub ? [pub.replace(/\/?$/, '/'), ...urls] : urls });
});
api.get('/search', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  res.json({
    customers: all('SELECT id, name, company, phone, city FROM customers WHERE name LIKE ? OR company LIKE ? OR phone LIKE ? OR mobile LIKE ? OR email LIKE ? LIMIT 8', q, q, q, q, q),
    vehicles: all(`SELECT v.id, v.plate, v.make, v.model, c.name AS customer_name FROM vehicles v LEFT JOIN customers c ON c.id=v.customer_id WHERE REPLACE(v.plate,' ','') LIKE REPLACE(?,' ','') OR v.vin LIKE ? OR v.model LIKE ? LIMIT 8`, q, q, q),
    documents: all('SELECT d.id, d.type, d.number, d.status, d.total, c.name AS customer_name FROM documents d LEFT JOIN customers c ON c.id=d.customer_id WHERE d.number LIKE ? OR d.reference LIKE ? ORDER BY d.id DESC LIMIT 8', q, q),
    products: all('SELECT id, ref, name, qty_on_hand, sale_price FROM products WHERE ref LIKE ? OR name LIKE ? OR ean LIKE ? LIMIT 8', q, q, q),
  });
});

// ---------- CRUD générique ----------
function crud(name, table, columns, { list, detail, beforeSave } = {}) {
  api.get(`/${name}`, (req, res) => res.json(list ? list(req) : all(`SELECT * FROM ${table} ORDER BY id DESC`)));
  api.get(`/${name}/:id`, wrap((req) => {
    const r = detail ? detail(Number(req.params.id)) : get(`SELECT * FROM ${table} WHERE id=?`, req.params.id);
    if (!r) throw new BusinessError('Introuvable', 404);
    return r;
  }));
  api.post(`/${name}`, wrap((req) => { const d = beforeSave ? beforeSave(req.body) : req.body; return { id: insert(table, d, columns) }; }));
  api.put(`/${name}/:id`, wrap((req) => { const d = beforeSave ? beforeSave(req.body) : req.body; update(table, req.params.id, d, columns); return { id: Number(req.params.id) }; }));
  api.delete(`/${name}/:id`, wrap((req) => {
    try { run(`DELETE FROM ${table} WHERE id=?`, req.params.id); } catch { throw new BusinessError('Suppression impossible : cet élément est utilisé ailleurs.'); }
    return { ok: true };
  }));
}

const upperPlate = (b) => ({ ...b, plate: b.plate ? b.plate.toUpperCase().trim() : b.plate, vin: b.vin ? b.vin.toUpperCase().trim() : b.vin });

crud('customers', 'customers', ['type', 'name', 'company', 'vat_number', 'email', 'phone', 'mobile', 'address', 'zip', 'city', 'country', 'payment_terms', 'notes', 'marketing_ok'], {
  list: (req) => {
    const q = `%${req.query.q || ''}%`;
    return all(`SELECT c.*, (SELECT COUNT(*) FROM vehicles WHERE customer_id=c.id) AS vehicle_count,
      (SELECT ROUND(SUM(total-amount_paid),2) FROM documents WHERE customer_id=c.id AND type='invoice' AND status IN ('posted','partial')) AS balance
      FROM customers c WHERE c.name LIKE ? OR c.company LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.mobile LIKE ? ORDER BY c.name LIMIT 500`, q, q, q, q, q);
  },
  detail: (id) => {
    const c = get('SELECT * FROM customers WHERE id=?', id);
    if (!c) return null;
    c.vehicles = all('SELECT * FROM vehicles WHERE customer_id=? ORDER BY id DESC', id);
    c.documents = all('SELECT d.id, d.type, d.number, d.status, d.date, d.total, d.amount_paid, v.plate FROM documents d LEFT JOIN vehicles v ON v.id=d.vehicle_id WHERE d.customer_id=? ORDER BY d.id DESC', id);
    return c;
  },
});
crud('vehicles', 'vehicles', ['customer_id', 'plate', 'vin', 'make', 'model', 'version', 'fuel', 'year', 'first_registration', 'mileage', 'color', 'engine_code', 'tyre_size', 'next_inspection', 'next_service_date', 'next_service_km', 'notes'], {
  beforeSave: upperPlate,
  list: (req) => {
    const q = `%${req.query.q || ''}%`;
    return all(`SELECT v.*, c.name AS customer_name FROM vehicles v LEFT JOIN customers c ON c.id=v.customer_id
      WHERE v.plate LIKE ? OR v.vin LIKE ? OR v.make LIKE ? OR v.model LIKE ? OR c.name LIKE ? ORDER BY v.id DESC LIMIT 500`, q, q, q, q, q);
  },
  detail: (id) => {
    const v = get('SELECT v.*, c.name AS customer_name FROM vehicles v LEFT JOIN customers c ON c.id=v.customer_id WHERE v.id=?', id);
    if (!v) return null;
    v.history = all(`SELECT d.id, d.type, d.number, d.status, d.date, d.mileage, d.total, d.customer_complaint,
      (SELECT GROUP_CONCAT(description, ' · ') FROM document_lines WHERE document_id=d.id AND kind!='text') AS summary
      FROM documents d WHERE d.vehicle_id=? ORDER BY d.date DESC, d.id DESC`, id);
    return v;
  },
});
crud('suppliers', 'suppliers', ['name', 'vat_number', 'email', 'phone', 'address', 'zip', 'city', 'country', 'iban', 'website', 'default_account', 'notes'], {
  list: () => all(`SELECT s.*, (SELECT ROUND(SUM(total-amount_paid),2) FROM purchases WHERE supplier_id=s.id AND posted=1 AND status!='paid') AS balance FROM suppliers s ORDER BY name`),
});
crud('products', 'products', ['ref', 'ean', 'name', 'category', 'brand', 'supplier_id', 'purchase_price', 'sale_price', 'tax_rate', 'qty_min', 'location', 'unit', 'is_service', 'labor_hours', 'active'], {
  list: (req) => {
    const q = `%${req.query.q || ''}%`;
    return all(`SELECT p.*, s.name AS supplier_name FROM products p LEFT JOIN suppliers s ON s.id=p.supplier_id
      WHERE (p.name LIKE ? OR p.ref LIKE ? OR p.ean LIKE ? OR p.brand LIKE ?) ${req.query.low ? 'AND p.qty_on_hand<=p.qty_min AND p.qty_min>0 AND p.is_service=0' : ''}
      ORDER BY p.name LIMIT 1000`, q, q, q, q);
  },
  detail: (id) => {
    const p = get('SELECT * FROM products WHERE id=?', id);
    if (p) p.moves = all('SELECT m.*, d.number AS doc_number, pu.number AS purchase_number FROM stock_moves m LEFT JOIN documents d ON d.id=m.document_id LEFT JOIN purchases pu ON pu.id=m.purchase_id WHERE m.product_id=? ORDER BY m.id DESC LIMIT 200', id);
    return p;
  },
});
api.post('/products/:id/adjust', wrap((req) => {
  const p = get('SELECT * FROM products WHERE id=?', req.params.id);
  if (!p) throw new BusinessError('Article introuvable', 404);
  const target = Number(req.body.qty);
  if (Number.isNaN(target)) throw new BusinessError('Quantité invalide');
  const diff = round2(target - p.qty_on_hand);
  if (diff) addStockMove({ product_id: p.id, qty: diff, kind: 'adjust', unit_cost: p.purchase_price, note: req.body.note || 'Inventaire', user_id: req.user.id });
  return { ok: true, diff };
}));
api.get('/stock/moves', (req, res) => res.json(all(`SELECT m.*, p.ref, p.name, d.number AS doc_number, pu.number AS purchase_number, u.name AS user_name FROM stock_moves m
  JOIN products p ON p.id=m.product_id LEFT JOIN documents d ON d.id=m.document_id LEFT JOIN purchases pu ON pu.id=m.purchase_id LEFT JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 500`)));
api.get('/stock/valuation', (req, res) => res.json(get('SELECT ROUND(SUM(qty_on_hand*purchase_price),2) AS purchase_value, ROUND(SUM(qty_on_hand*sale_price),2) AS sale_value, COUNT(*) AS items FROM products WHERE active=1 AND is_service=0 AND qty_on_hand>0')));
// Proposition de réapprovisionnement groupée par fournisseur
api.post('/stock/reorder', wrap(() => {
  const low = all('SELECT * FROM products WHERE active=1 AND is_service=0 AND qty_min>0 AND qty_on_hand<=qty_min AND supplier_id IS NOT NULL');
  const bySupplier = {};
  for (const p of low) (bySupplier[p.supplier_id] ||= []).push(p);
  const created = [];
  for (const [sid, items] of Object.entries(bySupplier)) {
    created.push(savePurchase({
      supplier_id: Number(sid), notes: 'Réapprovisionnement automatique',
      lines: items.map((p) => ({ product_id: p.id, description: `${p.ref || ''} ${p.name}`.trim(), quantity: Math.max(1, p.qty_min * 2 - p.qty_on_hand), unit_price: p.purchase_price, tax_rate: p.tax_rate })),
    }));
  }
  return { created };
}));

crud('appointments', 'appointments', ['customer_id', 'vehicle_id', 'mechanic_id', 'start', 'end', 'title', 'notes', 'status', 'document_id', 'courtesy_car'], {
  list: (req) => all(`SELECT a.*, c.name AS customer_name, c.phone AS customer_phone, v.plate, v.make, v.model, u.name AS mechanic_name, u.color AS mechanic_color, d.number AS document_number
    FROM appointments a LEFT JOIN customers c ON c.id=a.customer_id LEFT JOIN vehicles v ON v.id=a.vehicle_id LEFT JOIN users u ON u.id=a.mechanic_id LEFT JOIN documents d ON d.id=a.document_id
    WHERE substr(a.start,1,10) BETWEEN ? AND ? ORDER BY a.start`, req.query.from || '0000', req.query.to || '9999'),
});
// Arrivée du véhicule : création de l'OR depuis le rendez-vous
api.post('/appointments/:id/order', wrap((req) => {
  const a = get('SELECT * FROM appointments WHERE id=?', req.params.id);
  if (!a) throw new BusinessError('Rendez-vous introuvable', 404);
  if (a.document_id) return { id: a.document_id };
  const id = saveDocument({ type: 'order', customer_id: a.customer_id, vehicle_id: a.vehicle_id, mechanic_id: a.mechanic_id, customer_complaint: [a.title, a.notes].filter(Boolean).join(' — '), promised_at: a.end, lines: [] });
  run("UPDATE appointments SET document_id=?, status='arrived' WHERE id=?", id, a.id);
  return { id };
}));

// ---------- Documents ----------
api.get('/documents', (req, res) => {
  const where = ['1=1'];
  const p = [];
  if (req.query.type) { where.push('d.type IN (' + req.query.type.split(',').map(() => '?').join(',') + ')'); p.push(...req.query.type.split(',')); }
  if (req.query.status) { where.push('d.status IN (' + req.query.status.split(',').map(() => '?').join(',') + ')'); p.push(...req.query.status.split(',')); }
  if (req.query.customer_id) { where.push('d.customer_id=?'); p.push(req.query.customer_id); }
  if (req.query.overdue) { where.push("d.status IN ('posted','partial') AND d.due_date<?"); p.push(today()); }
  if (req.query.q) { const q = `%${req.query.q}%`; where.push('(d.number LIKE ? OR c.name LIKE ? OR v.plate LIKE ?)'); p.push(q, q, q); }
  res.json(all(`SELECT d.id, d.type, d.number, d.status, d.date, d.due_date, d.subtotal, d.total, d.amount_paid, d.promised_at, d.customer_complaint,
      d.mechanic_id, d.stage, c.name AS customer_name, v.plate, v.make, v.model, u.name AS mechanic_name, u.color AS mechanic_color,
      (SELECT ROUND(SUM(quantity),2) FROM document_lines WHERE document_id=d.id AND kind='labor') AS hours_sold,
      (SELECT COUNT(*) FROM time_entries WHERE document_id=d.id AND end IS NULL AND kind='work') AS active_workers
    FROM documents d LEFT JOIN customers c ON c.id=d.customer_id LEFT JOIN vehicles v ON v.id=d.vehicle_id LEFT JOIN users u ON u.id=d.mechanic_id
    WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT 1000`, ...p));
});
api.get('/documents/:id', wrap((req) => getDocument(Number(req.params.id))));
api.post('/documents', wrap((req) => ({ id: saveDocument(req.body) })));
api.put('/documents/:id', wrap((req) => ({ id: saveDocument(req.body, Number(req.params.id)) })));
api.delete('/documents/:id', wrap((req) => {
  const d = get('SELECT * FROM documents WHERE id=?', req.params.id);
  if (!d) throw new BusinessError('Introuvable', 404);
  if ((d.type === 'invoice' || d.type === 'credit_note') && d.status !== 'draft') throw new BusinessError('Une facture validée ne peut pas être supprimée : créez une note de crédit.');
  tx(() => {
    run('UPDATE documents SET parent_id=NULL WHERE parent_id=?', d.id);
    run('UPDATE appointments SET document_id=NULL WHERE document_id=?', d.id);
    run('DELETE FROM documents WHERE id=?', d.id);
  });
  return { ok: true };
}));
api.post('/documents/:id/status', wrap((req) => {
  const allowed = { quote: ['draft', 'sent', 'accepted', 'refused'], order: ['open', 'in_progress', 'waiting_parts', 'done', 'cancelled'] };
  const d = get('SELECT * FROM documents WHERE id=?', req.params.id);
  if (!allowed[d?.type]?.includes(req.body.status)) throw new BusinessError('Statut invalide');
  if (d.status === 'invoiced') throw new BusinessError('OR déjà facturé');
  run('UPDATE documents SET status=? WHERE id=?', req.body.status, d.id);
  if (d.type === 'order') stageFromStatus(d.id, req.body.status);
  return { ok: true };
}));
api.post('/documents/:id/convert', wrap((req) => {
  const id = convertDocument(Number(req.params.id), req.body.type);
  const n = get('SELECT type, number FROM documents WHERE id=?', id);
  logMessage('document', Number(req.params.id), `➡️ ${{ order: 'Ordre de réparation', invoice: 'Facture', credit_note: 'Note de crédit' }[n.type]} créé(e) ${n.number || ''}`, req.user.id, 'system');
  logMessage('document', id, `Créé(e) à partir de ${get('SELECT number FROM documents WHERE id=?', req.params.id).number || 'un brouillon'}`, req.user.id, 'system');
  return { id };
}));
api.post('/documents/:id/post', wrap((req) => {
  const number = postInvoice(Number(req.params.id));
  logMessage('document', Number(req.params.id), `✔ Validée sous le numéro ${number}`, req.user.id, 'system');
  return { number };
}));
api.post('/documents/:id/payments', wrap((req) => {
  const id = registerPayment({ ...req.body, document_id: Number(req.params.id) });
  logMessage('document', Number(req.params.id), `💶 Paiement enregistré : ${Number(req.body.amount).toFixed(2)} €`, req.user.id, 'system');
  return { id };
}));
// QR code de paiement SEPA (EPC) imprimé sur la facture — scannable par les applis bancaires
api.get('/documents/:id/qr.svg', wrap(async (req, res) => {
  const d = getDocument(Number(req.params.id));
  const c = getSettings().company;
  const residual = round2(d.total - d.amount_paid);
  if (!c.iban || residual <= 0) return res.status(204).end();
  const payload = ['BCD', '002', '1', 'SCT', c.bic || '', (c.name || '').slice(0, 70), c.iban.replace(/\s/g, ''), `EUR${residual.toFixed(2)}`, '', '', d.number || '', ''].join('\n');
  res.type('image/svg+xml').send(await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }));
}));

// ---------- Achats ----------
api.get('/purchases', (req, res) => res.json(all(`SELECT p.*, s.name AS supplier_name, (SELECT COUNT(*) FROM attachments a WHERE a.model='purchase' AND a.record_id=p.id) AS attachment_count
  FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id ${req.query.review ? "WHERE p.review='to_review' AND p.posted=0" : ''} ORDER BY p.id DESC LIMIT 1000`)));
api.get('/purchases/:id', wrap((req) => getPurchase(Number(req.params.id))));
api.post('/purchases', wrap((req) => ({ id: savePurchase(req.body) })));
api.put('/purchases/:id', wrap((req) => ({ id: savePurchase(req.body, Number(req.params.id)) })));
api.delete('/purchases/:id', wrap((req) => {
  const p = get('SELECT * FROM purchases WHERE id=?', req.params.id);
  if (p?.posted) throw new BusinessError('Achat comptabilisé : suppression impossible');
  if (get('SELECT 1 FROM purchase_lines WHERE purchase_id=? AND received_qty>0', req.params.id)) throw new BusinessError('Marchandise déjà réceptionnée');
  run('DELETE FROM purchases WHERE id=?', req.params.id);
  return { ok: true };
}));
api.post('/purchases/:id/order', wrap((req) => { run("UPDATE purchases SET status='ordered' WHERE id=? AND status='draft'", req.params.id); return { ok: true }; }));
api.post('/purchases/:id/receive', wrap((req) => { receivePurchase(Number(req.params.id)); return { ok: true }; }));
api.post('/purchases/:id/post', wrap((req) => { postPurchase(Number(req.params.id)); run("UPDATE purchases SET review='ok' WHERE id=?", req.params.id); return { ok: true }; }));
api.post('/purchases/:id/reviewed', wrap((req) => { run("UPDATE purchases SET review='ok' WHERE id=?", req.params.id); return { ok: true }; }));
api.post('/purchases/:id/reanalyze', wrap((req) => reanalyze(Number(req.params.id))));

// ---------- Factures fournisseurs : dépôt de fichier, boîte e-mail, pièces jointes ----------
const rawBody = express.raw({ type: () => true, limit: '40mb' });
const fileMeta = (req) => ({ buffer: req.body, mime: (req.headers['content-type'] || '').split(';')[0].toLowerCase(), filename: decodeURIComponent(req.headers['x-filename'] || 'document') });
api.post('/bills/upload', rawBody, wrap((req) => createBillFromFile({ ...fileMeta(req), source: 'upload' })));
api.get('/bills/inbox', (req, res) => res.json(publicInboxConfig()));
api.put('/bills/inbox', adminOnly, wrap((req) => { saveInboxConfig(req.body); return publicInboxConfig(); }));
api.post('/bills/inbox/test', adminOnly, wrap(() => testInbox()));
api.post('/bills/inbox/check', wrap(() => checkInbox()));
api.get('/attachments/:model/:id', (req, res) => res.json(listAttachments(req.params.model, Number(req.params.id))));
api.post('/attachments/:model/:id', rawBody, wrap((req) => {
  if (!['purchase', 'document', 'customer', 'vehicle', 'supplier', 'product'].includes(req.params.model)) throw new BusinessError('Type de fiche inconnu');
  if (!req.body?.length) throw new BusinessError('Fichier vide');
  return { id: saveAttachment(req.params.model, Number(req.params.id), { ...fileMeta(req), source: 'manual' }) };
}));
api.get('/attachment/:id', (req, res) => {
  const a = attachmentFile(Number(req.params.id));
  if (!a) return res.status(404).end();
  res.type(a.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.sendFile(a.full);
});
api.delete('/attachment/:id', wrap((req) => { deleteAttachment(Number(req.params.id)); return { ok: true }; }));
api.post('/purchases/:id/payments', wrap((req) => ({ id: registerPayment({ ...req.body, purchase_id: Number(req.params.id) }) })));

// ---------- Comptabilité ----------
const period = (req) => [req.query.from || `${today().slice(0, 4)}-01-01`, req.query.to || today()];
api.get('/accounting/accounts', (req, res) => res.json(all('SELECT * FROM accounts ORDER BY code')));
api.post('/accounting/accounts', adminOnly, wrap((req) => {
  const { code, name, type } = req.body;
  if (!code || !name || !['asset', 'liability', 'equity', 'income', 'expense'].includes(type)) throw new BusinessError('Compte invalide');
  run('INSERT INTO accounts(code,name,type) VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name, type=excluded.type', code, name, type);
  return { ok: true };
}));
api.get('/accounting/journals', (req, res) => res.json(all('SELECT * FROM journals')));
api.get('/accounting/moves', (req, res) => {
  const [from, to] = period(req);
  const moves = all(`SELECT * FROM moves WHERE date BETWEEN ? AND ? ${req.query.journal ? 'AND journal_code=?' : ''} ORDER BY date DESC, id DESC LIMIT 1000`, from, to, ...(req.query.journal ? [req.query.journal] : []));
  const lines = moves.length ? all(`SELECT l.*, a.name AS account_name FROM move_lines l JOIN accounts a ON a.code=l.account_code WHERE move_id IN (${moves.map(() => '?').join(',')})`, ...moves.map((m) => m.id)) : [];
  for (const m of moves) m.lines = lines.filter((l) => l.move_id === m.id);
  res.json(moves);
});
api.post('/accounting/moves', wrap((req) => {
  const { date, label, lines, journal_code = 'OD' } = req.body;
  return { id: tx(() => createMove({ journal_code, date: date || today(), ref: 'OD', label }, (lines || []).map((l) => ({ account_code: l.account_code, label: l.label || label, debit: round2(l.debit), credit: round2(l.credit) })))) };
}));
api.get('/accounting/ledger/:code', (req, res) => {
  const [from, to] = period(req);
  const opening = get('SELECT ROUND(COALESCE(SUM(l.debit-l.credit),0),2) v FROM move_lines l JOIN moves m ON m.id=l.move_id WHERE l.account_code=? AND m.date<?', req.params.code, from).v;
  const lines = all(`SELECT l.*, m.date, m.ref, m.journal_code, m.label AS move_label FROM move_lines l JOIN moves m ON m.id=l.move_id
    WHERE l.account_code=? AND m.date BETWEEN ? AND ? ORDER BY m.date, m.id`, req.params.code, from, to);
  let bal = opening;
  for (const l of lines) { bal = round2(bal + l.debit - l.credit); l.balance = bal; }
  res.json({ account: get('SELECT * FROM accounts WHERE code=?', req.params.code), opening, lines });
});
api.get('/accounting/balance', (req, res) => res.json(trialBalance(...period(req))));
api.get('/accounting/vat', (req, res) => res.json(vatReport(...period(req))));
api.get('/accounting/pnl', (req, res) => res.json(profitAndLoss(...period(req))));
api.get('/accounting/aged', (req, res) => {
  const t = today();
  res.json(all(`SELECT d.id, d.number, d.date, d.due_date, d.total, d.amount_paid, ROUND(d.total-d.amount_paid,2) AS residual, c.id AS customer_id, c.name AS customer_name, c.email, c.phone,
    CAST(julianday(?) - julianday(d.due_date) AS INTEGER) AS days_late
    FROM documents d JOIN customers c ON c.id=d.customer_id WHERE d.type='invoice' AND d.status IN ('posted','partial') ORDER BY d.due_date`, t));
});
// Export FEC-like (CSV) pour la fiduciaire
api.get('/accounting/export.csv', (req, res) => {
  const [from, to] = period(req);
  const rows = all(`SELECT m.journal_code, m.id AS move_id, m.date, m.ref, l.account_code, a.name AS account_name, l.partner_type, l.partner_id, l.label, l.debit, l.credit
    FROM move_lines l JOIN moves m ON m.id=l.move_id JOIN accounts a ON a.code=l.account_code WHERE m.date BETWEEN ? AND ? ORDER BY m.date, m.id`, from, to);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['Journal;Piece;Date;Reference;Compte;LibelleCompte;TypeTiers;IdTiers;Libelle;Debit;Credit',
    ...rows.map((r) => [r.journal_code, r.move_id, r.date, r.ref, r.account_code, r.account_name, r.partner_type, r.partner_id, r.label, String(r.debit).replace('.', ','), String(r.credit).replace('.', ',')].map(esc).join(';'))].join('\r\n');
  res.type('text/csv').attachment(`ecritures_${from}_${to}.csv`).send('﻿' + csv);
});

// ---------- Banque ----------
crud('bank-accounts', 'bank_accounts', ['name', 'iban', 'bic', 'bank_name', 'account_code', 'opening_balance', 'provider', 'provider_config'], {
  list: () => all(`SELECT b.*, (SELECT COUNT(*) FROM bank_lines WHERE bank_account_id=b.id AND status='unmatched') AS unmatched,
    ROUND(b.opening_balance + COALESCE((SELECT SUM(amount) FROM bank_lines WHERE bank_account_id=b.id),0),2) AS statement_balance FROM bank_accounts b ORDER BY b.id`),
});
api.get('/bank/providers', (req, res) => res.json(PROVIDERS));
api.get('/bank/lines', (req, res) => {
  const lines = all(`SELECT l.*, b.name AS account_name FROM bank_lines l JOIN bank_accounts b ON b.id=l.bank_account_id
    WHERE (? IS NULL OR l.bank_account_id=?) AND (? IS NULL OR l.status=?) ORDER BY l.date DESC, l.id DESC LIMIT 500`,
  req.query.account || null, req.query.account || null, req.query.status || null, req.query.status || null);
  for (const l of lines) if (l.status === 'unmatched') l.suggestions = suggestions(l);
  res.json(lines);
});
api.post('/bank/import/:accountId', wrap((req) => {
  const text = typeof req.body === 'string' ? req.body : req.body.content;
  if (!text) throw new BusinessError('Fichier vide');
  const lines = /<\?xml|<Document/i.test(text) ? parseCamt(text) : parseCsv(text);
  if (!lines.length) throw new BusinessError('Aucune opération reconnue dans ce fichier (formats acceptés : CAMT.053 XML, CSV).');
  return importLines(Number(req.params.accountId), lines);
}));
api.post('/bank/sync/:accountId', wrap((req) => syncAccount(Number(req.params.accountId))));
api.post('/bank/lines/:id/match', wrap((req) => ({ payment_id: matchLine(Number(req.params.id), req.body) })));
api.post('/bank/lines/:id/assign', wrap((req) => ({ move_id: assignLine(Number(req.params.id), req.body.account_code, req.body.label) })));
api.post('/bank/lines/:id/ignore', wrap((req) => { run("UPDATE bank_lines SET status='ignored' WHERE id=? AND status='unmatched'", req.params.id); return { ok: true }; }));
api.post('/bank/auto-reconcile', wrap(() => autoReconcile()));
api.get('/payments', (req, res) => res.json(all(`SELECT p.*, d.number AS document_number, pu.number AS purchase_number, c.name AS customer_name, s.name AS supplier_name
  FROM payments p LEFT JOIN documents d ON d.id=p.document_id LEFT JOIN purchases pu ON pu.id=p.purchase_id LEFT JOIN customers c ON c.id=p.customer_id LEFT JOIN suppliers s ON s.id=p.supplier_id
  ORDER BY p.date DESC, p.id DESC LIMIT 500`)));

// ---------- Pointage (vue bureau) ----------
api.get('/timesheets', (req, res) => {
  const from = req.query.from || today();
  const to = req.query.to || today();
  const entries = all(`SELECT t.*, u.name AS user_name, u.color, d.number AS document_number, v.plate FROM time_entries t JOIN users u ON u.id=t.user_id
    LEFT JOIN documents d ON d.id=t.document_id LEFT JOIN vehicles v ON v.id=d.vehicle_id WHERE substr(t.start,1,10) BETWEEN ? AND ? ORDER BY t.start`, from, to);
  for (const e of entries) e.hours = round2(durationHours(e));
  const users = all("SELECT id, name, color, hourly_cost FROM users WHERE role='mechanic' AND active=1 ORDER BY name").map((u) => {
    const mine = entries.filter((e) => e.user_id === u.id);
    const presence = round2(mine.filter((e) => e.kind === 'presence').reduce((s, e) => s + e.hours, 0));
    const work = round2(mine.filter((e) => e.kind === 'work').reduce((s, e) => s + e.hours, 0));
    return { ...u, presence, work, productivity: presence ? Math.round((work / presence) * 100) : null, active: mine.some((e) => !e.end) };
  });
  res.json({ entries, users });
});
api.put('/timesheets/:id', wrap((req) => { update('time_entries', req.params.id, req.body, ['start', 'end', 'note', 'document_id']); return { ok: true }; }));
api.delete('/timesheets/:id', wrap((req) => { run('DELETE FROM time_entries WHERE id=?', req.params.id); return { ok: true }; }));

// ---------- Utilisateurs & paramètres ----------
api.get('/users', (req, res) => res.json(all('SELECT id, name, email, role, color, hourly_cost, active, pin_hash IS NOT NULL AS has_pin FROM users ORDER BY role, name')));
api.post('/users', adminOnly, wrap((req) => {
  const b = req.body;
  if (!b.name || !['admin', 'office', 'mechanic'].includes(b.role)) throw new BusinessError('Nom et rôle requis');
  if (b.role !== 'mechanic' && (!b.email || !b.password)) throw new BusinessError('E-mail et mot de passe requis pour un accès bureau');
  if (b.role === 'mechanic' && !/^\d{4,6}$/.test(b.pin || '')) throw new BusinessError('Code PIN de 4 à 6 chiffres requis');
  return { id: insert('users', { ...b, email: b.email?.toLowerCase(), password_hash: b.password ? hashSecret(b.password) : null, pin_hash: b.pin ? hashSecret(b.pin) : null },
    ['name', 'email', 'role', 'color', 'hourly_cost', 'password_hash', 'pin_hash']) };
}));
api.put('/users/:id', adminOnly, wrap((req) => {
  const b = req.body;
  const data = { ...b, email: b.email?.toLowerCase() };
  if (b.password) data.password_hash = hashSecret(b.password);
  if (b.pin) { if (!/^\d{4,6}$/.test(b.pin)) throw new BusinessError('PIN : 4 à 6 chiffres'); data.pin_hash = hashSecret(b.pin); }
  if (Number(req.params.id) === req.user.id && (b.active === false || b.active === 0 || (b.role && b.role !== 'admin'))) throw new BusinessError('Vous ne pouvez pas désactiver votre propre compte admin');
  update('users', req.params.id, data, ['name', 'email', 'role', 'color', 'hourly_cost', 'active', 'password_hash', 'pin_hash']);
  if (b.active === false || b.active === 0) run('DELETE FROM sessions WHERE user_id=?', req.params.id);
  return { ok: true };
}));
api.get('/me', (req, res) => res.json(req.user));
api.get('/settings', (req, res) => { const { odoo, ...s } = getSettings(); res.json(s); });
api.put('/settings', adminOnly, wrap((req) => {
  for (const k of ['company', 'workshop', 'numbering', 'invoice_footer', 'ai', 'public_url']) if (req.body[k] !== undefined) setSetting(k, req.body[k]);
  const { odoo, ...s } = getSettings();
  return s;
}));

// ---------- Import Odoo ----------
api.get('/odoo', (req, res) => res.json({ config: publicOdooConfig(), job: odooJob, last: getSettings().odoo_last_import || null }));
api.put('/odoo', adminOnly, wrap((req) => { saveOdooConfig(req.body); return { config: publicOdooConfig() }; }));
api.post('/odoo/test', adminOnly, wrap(() => testConnection()));
api.post('/odoo/import', adminOnly, wrap((req) => {
  if (odooJob.running) throw new BusinessError('Un import est déjà en cours');
  runImport(req.body?.options);
  return odooJob;
}));

mountLive(app, api);

// ---------- E-mails ----------
const checkModel = (m) => { if (m && !MODELS.includes(m)) throw new BusinessError('Type de fiche inconnu'); return m || null; };
api.get('/mail/config', (req, res) => res.json(publicMailConfig()));
api.put('/mail/config', adminOnly, wrap((req) => { saveMailConfig(req.body); return publicMailConfig(); }));
api.post('/mail/test', adminOnly, wrap(() => testMail()));
api.get('/mail/compose', wrap((req) => compose(checkModel(req.query.model), Number(req.query.id) || null, req.query.template, publicUrl(req))));
api.get('/qr.svg', wrap(async (req, res) => res.type('image/svg+xml').send(await QRCode.toString(String(req.query.text || '').slice(0, 500), { type: 'svg', margin: 1 }))));
api.post('/mail/preview', wrap(async (req) => {
  const { html } = await renderEmail({ model: checkModel(req.body.model), record_id: Number(req.body.record_id) || null, intro: req.body.intro || '', include_document: req.body.include_document });
  return { html: html.replace('cid:qrpay', `/api/documents/${Number(req.body.record_id)}/qr.svg`) };
}));
api.post('/mail/send', wrap((req) => sendEmail({ ...req.body, model: checkModel(req.body.model), record_id: Number(req.body.record_id) || null, user_id: req.user.id })));
api.get('/mail/outbox', (req, res) => res.json(all(`SELECT e.*, u.name AS user_name FROM emails e LEFT JOIN users u ON u.id=e.user_id ORDER BY e.id DESC LIMIT 300`)
  .map((e) => ({ ...e, record: recordInfo(e.model, e.record_id) }))));
api.delete('/mail/:id', wrap((req) => {
  const e = get("SELECT * FROM emails WHERE id=? AND status='scheduled'", req.params.id);
  if (!e) throw new BusinessError('Seul un e-mail programmé peut être annulé');
  run("UPDATE emails SET status='cancelled' WHERE id=?", e.id);
  logMessage(e.model, e.record_id, `🚫 E-mail programmé annulé : « ${e.subject} »`, req.user.id, 'system');
  return { ok: true };
}));
// Rédaction assistée : Sophie (secrétariat) écrit le texte du mail
api.post('/mail/draft-ai', wrap(async (req) => {
  const info = recordInfo(checkModel(req.body.model), Number(req.body.record_id)) || {};
  const prompt = `Rédige le texte d'un e-mail professionnel à envoyer par le garage${info.name ? ` à ${info.name}` : ''}.
Contexte : ${info.label || 'aucune fiche liée'}. Objet prévu : ${req.body.subject || '—'}.
Consigne du gérant : ${req.body.instruction || 'améliore et rends plus chaleureux le texte actuel'}.
Texte actuel :
${req.body.intro || ''}

Réponds UNIQUEMENT avec le corps du message en texte brut (salutation, contenu, formule de politesse), sans objet ni commentaire. Si besoin, consulte les données avec tes outils.`;
  try { return { intro: await runAgent('secretariat', [{ role: 'user', content: prompt }]) }; } catch (e) { throw new BusinessError(friendlyError(e)); }
}));

// ---------- Historique & activités (sur chaque fiche) ----------
api.get('/chatter/:model/:id', wrap((req) => chatter(checkModel(req.params.model), Number(req.params.id))));
api.post('/chatter/:model/:id/note', wrap((req) => {
  if (!req.body.body?.trim()) throw new BusinessError('Note vide');
  logMessage(checkModel(req.params.model), Number(req.params.id), req.body.body.trim(), req.user.id, 'note');
  return { ok: true };
}));
api.get('/activities/meta', (req, res) => res.json({ modules: MODULES, types: ACTIVITY_TYPES, templates: TEMPLATE_LABELS }));
api.get('/activities/counts', (req, res) => res.json(activityCounts(req.user.id)));
api.get('/activities', (req, res) => res.json(listActivities({
  user_id: req.query.mine ? req.user.id : req.query.user_id || null, module: req.query.module || null,
  model: req.query.model || null, record_id: req.query.record_id || null, status: req.query.status || 'planned', scope: req.query.scope,
})));
api.post('/activities', wrap((req) => ({ id: createActivity({ ...req.body, model: checkModel(req.body.model) }, req.user.id) })));
api.put('/activities/:id', wrap((req) => { update('activities', req.params.id, req.body, ACTIVITY_COLS.filter((c) => !['created_by', 'model', 'record_id'].includes(c))); return { ok: true }; }));
api.post('/activities/:id/done', wrap((req) => completeActivity(Number(req.params.id), req.body.feedback, req.user.id)));
api.delete('/activities/:id', wrap((req) => { run("UPDATE activities SET status='cancelled' WHERE id=?", req.params.id); return { ok: true }; }));

// ---------- Bureau virtuel IA ----------
api.get('/agents', (req, res) => res.json(AGENTS.map(({ prompt, ...a }) => ({
  ...a, working: running.has(a.id),
  unread: get('SELECT COUNT(*) n FROM agent_results WHERE agent_id=? AND read=0', a.id).n,
  tasks: get('SELECT COUNT(*) n FROM agent_tasks WHERE agent_id=? AND active=1', a.id).n,
}))));
api.get('/agents/:id/messages', (req, res) => res.json(all('SELECT * FROM agent_messages WHERE agent_id=? ORDER BY id DESC LIMIT 100', req.params.id).reverse()));
api.delete('/agents/:id/messages', (req, res) => { clearHistory(req.params.id); res.json({ ok: true }); });
api.post('/agents/:id/chat', wrap(async (req) => {
  if (!req.body.message?.trim()) throw new BusinessError('Message vide');
  running.add(req.params.id);
  try { return { reply: await chat(req.params.id, req.body.message.trim()) }; } finally { running.delete(req.params.id); }
}));
api.post('/agents/meeting', wrap(async (req) => {
  if (!req.body.question?.trim()) throw new BusinessError('Question vide');
  AGENTS.forEach((a) => running.add(a.id));
  try { return await meeting(req.body.question.trim()); } finally { AGENTS.forEach((a) => running.delete(a.id)); }
}));
const TASK_COLS = ['agent_id', 'title', 'prompt', 'schedule_type', 'schedule_time', 'schedule_day', 'run_at', 'next_run', 'active'];
api.get('/agent-tasks', (req, res) => res.json(all(`SELECT * FROM agent_tasks ${req.query.agent ? 'WHERE agent_id=?' : ''} ORDER BY active DESC, next_run`, ...(req.query.agent ? [req.query.agent] : []))));
api.post('/agent-tasks', wrap((req) => {
  const t = { active: 1, ...req.body };
  if (!t.agent_id || !t.title || !t.prompt) throw new BusinessError('Agent, titre et consigne requis');
  t.next_run = computeNextRun(t);
  return { id: insert('agent_tasks', t, TASK_COLS) };
}));
api.put('/agent-tasks/:id', wrap((req) => {
  const cur = get('SELECT * FROM agent_tasks WHERE id=?', req.params.id);
  const t = { ...cur, ...req.body };
  t.next_run = t.active ? computeNextRun({ ...t, last_run: t.schedule_type === 'once' && req.body.run_at ? null : t.last_run }) : null;
  update('agent_tasks', req.params.id, t, TASK_COLS);
  return { ok: true };
}));
api.delete('/agent-tasks/:id', wrap((req) => { run('DELETE FROM agent_tasks WHERE id=?', req.params.id); return { ok: true }; }));
api.post('/agent-tasks/:id/run', wrap(async (req) => {
  const t = get('SELECT * FROM agent_tasks WHERE id=?', req.params.id);
  if (!t) throw new BusinessError('Tâche introuvable', 404);
  if (running.has(t.agent_id)) throw new BusinessError('Cet agent est déjà occupé');
  return { content: await executeTask(t) };
}));
api.get('/agent-results', (req, res) => res.json(all(`SELECT * FROM agent_results ${req.query.agent ? 'WHERE agent_id=?' : ''} ORDER BY id DESC LIMIT 100`, ...(req.query.agent ? [req.query.agent] : []))));
api.post('/agent-results/:id/read', (req, res) => { run('UPDATE agent_results SET read=1 WHERE id=?', req.params.id); res.json({ ok: true }); });
api.delete('/agent-results/:id', (req, res) => { run('DELETE FROM agent_results WHERE id=?', req.params.id); res.json({ ok: true }); });

// ---------- Erreurs ----------
app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.resolve('public/index.html')));
api.use((req, res) => res.status(404).json({ error: 'Route inconnue' }));
app.use((err, req, res, _next) => {
  if (!(err instanceof BusinessError)) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Erreur serveur' });
});

const PORT = Number(process.env.PORT || 3000);
startScheduler();
startInboxPolling();
setInterval(() => processScheduledEmails().catch((e) => console.error('E-mails programmés', e)), 30_000);
app.listen(PORT, () => {
  console.log(`\n🚗  Garage — logiciel de gestion démarré : http://localhost:${PORT}`);
  console.log(`🔧  Pointage atelier (tablette) : http://localhost:${PORT}/kiosk.html`);
  console.log(aiConfigured() ? '🤖  Agents IA : actifs' : '🤖  Agents IA : mode démo (ajoutez ANTHROPIC_API_KEY dans .env)');
});
