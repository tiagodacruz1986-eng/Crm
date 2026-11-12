// Corrections issues de l'audit : droits d'accès, présences, calculs, banque, e-mails.
// Le test démarre un vrai serveur sur une base vide et passe par l'API, comme le navigateur.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-audit-'));
let server, admin;

async function call(method, url, body, tok, headers = {}) {
  const raw = Buffer.isBuffer(body) || typeof body === 'string';
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const A = (method, url, body, headers) => call(method, url, body, admin, headers);
/** Crée un utilisateur de bureau avec les droits donnés et renvoie son jeton. */
async function userWith(perms, name = 'U' + Math.random().toString(36).slice(2, 8)) {
  const email = `${name.toLowerCase()}@t.lu`;
  const r = await A('POST', '/users', { name, email, role: 'office', password: 'secret123', permissions: perms });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const l = await call('POST', '/auth/login', { email, password: 'secret123' });
  return { id: r.data.id, tok: l.data.token };
}

before(async () => {
  let out = '';
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', PUBLIC_URL: '', MAIL_TRANSPORT: 'json' }, stdio: 'pipe' });
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 80 && !/démarré/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  const s = await call('POST', '/auth/setup', { name: 'Gérant', email: 'g@t.lu', password: 'secret123', company: 'Garage Test' });
  assert.equal(s.status, 200, out);
  admin = s.data.token;
});
after(() => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('droits : une majuscule dans l\'adresse ne contourne plus les droits', async () => {
  const zero = await userWith({});
  assert.equal((await call('GET', '/customers', undefined, zero.tok)).status, 403);
  for (const p of ['/Customers', '/CUSTOMERS', '/Accounting/balance', '/Documents', '/Bank/lines']) {
    const r = await call('GET', p, undefined, zero.tok);
    assert.ok([403, 404].includes(r.status), `${p} → ${r.status}`);
  }
  assert.ok([403, 404].includes((await call('POST', '/Customers', { name: 'Pirate' }, zero.tok)).status));
  assert.equal((await A('GET', '/customers')).data.some((c) => c.name === 'Pirate'), false);
});

test('droits : pièces jointes, historique, activités et e-mails suivent le droit sur la fiche', async () => {
  const cust = (await A('POST', '/customers', { name: 'Jean Muller', email: 'jean@t.lu' })).data.id;
  const inv = (await A('POST', '/documents', { type: 'invoice', customer_id: cust, lines: [{ kind: 'part', description: 'Filtre', quantity: 1, unit_price: 100, vat_rate: 17 }] })).data.id;
  const att = (await A('POST', `/attachments/customer/${cust}`, Buffer.from('bonjour'), { 'Content-Type': 'application/pdf', 'X-Filename': 'note.pdf' })).data.id;
  const act = (await A('POST', '/activities', { model: 'customer', record_id: cust, summary: 'Rappeler', due_date: '2030-01-01' })).data.id;
  const zero = await userWith({ inventaire: 'user' });
  assert.equal((await call('GET', `/attachments/customer/${cust}`, undefined, zero.tok)).status, 403);
  assert.equal((await call('GET', `/attachment/${att}`, undefined, zero.tok)).status, 403);
  assert.equal((await call('DELETE', `/attachment/${att}`, undefined, zero.tok)).status, 403);
  assert.equal((await call('GET', `/chatter/customer/${cust}`, undefined, zero.tok)).status, 403);
  assert.equal((await call('POST', `/chatter/document/${inv}/note`, { body: 'x' }, zero.tok)).status, 403);
  assert.equal((await call('POST', '/activities', { model: 'customer', record_id: cust, summary: 'x', due_date: '2030-01-01' }, zero.tok)).status, 403);
  assert.equal((await call('POST', `/activities/${act}/done`, {}, zero.tok)).status, 403, 'activité d\'un autre');
  assert.equal((await call('DELETE', `/activities/${act}`, undefined, zero.tok)).status, 403);
  const mine = await call('GET', '/activities', undefined, zero.tok);
  assert.equal(mine.status, 200);
  assert.equal(mine.data.find((a) => a.id === act).record, null, 'la fiche liée est masquée');
  assert.equal((await call('GET', `/mail/compose?model=document&id=${inv}`, undefined, zero.tok)).status, 403);
  assert.equal((await call('POST', '/mail/preview', { model: 'document', record_id: inv, include_document: true }, zero.tok)).status, 403);
  // … mais restent ouverts à qui a le droit sur la fiche
  const ok = await userWith({ contacts: 'user', ventes: 'read' });
  assert.equal((await call('GET', `/attachments/customer/${cust}`, undefined, ok.tok)).status, 200);
  assert.equal((await call('GET', `/chatter/document/${inv}`, undefined, ok.tok)).status, 200);
  assert.equal((await call('GET', `/mail/compose?model=document&id=${inv}`, undefined, ok.tok)).status, 200);
  assert.equal((await call('DELETE', `/attachment/${att}`, undefined, ok.tok)).status, 200, 'retirer une pièce jointe : niveau Utilisateur');
  // Activités et plan comptable pour les profils sans « E-mails » ni « Comptabilité »
  const mag = await userWith({ inventaire: 'manager', achats: 'user' });
  assert.equal((await call('GET', '/mail/config', undefined, mag.tok)).status, 200);
  assert.equal((await call('GET', '/accounting/accounts', undefined, mag.tok)).status, 200);
  assert.equal((await call('GET', '/accounting/balance', undefined, mag.tok)).status, 403);
  const users = (await call('GET', '/users', undefined, mag.tok)).data;
  assert.equal('hourly_cost' in users[0] || 'email' in users[0], false, 'coût horaire et e-mails réservés');
  assert.equal((await call('GET', '/odoo', undefined, mag.tok)).status, 403);
});

test('droits : documents filtrés par type, corrections de pointage réservées', async () => {
  const cust = (await A('POST', '/customers', { name: 'Anna' })).data.id;
  await A('POST', '/documents', { type: 'order', customer_id: cust, lines: [] });
  await A('POST', '/documents', { type: 'quote', customer_id: cust, lines: [] });
  const ventes = await userWith({ ventes: 'read' });
  const list = await call('GET', '/documents', undefined, ventes.tok);
  assert.equal(list.status, 200);
  assert.equal(list.data.some((d) => d.type === 'order'), false, 'pas d\'OR sans le droit Atelier');
  assert.equal((await call('GET', '/documents?type=quote,order', undefined, ventes.tok)).status, 403);
  assert.equal((await call('GET', '/documents?type=order&type=quote', undefined, ventes.tok)).status, 403);
  const atelier = await userWith({ atelier: 'user' });
  assert.equal((await call('POST', '/documents?type=order', { type: 'invoice', customer_id: cust, lines: [] }, atelier.tok)).status, 403, 'le type vient du corps de la requête');
  // Pointages
  const pres = await userWith({ presences: 'user' });
  const id = (await A('POST', '/attendance', { user_id: pres.id, start: '2026-03-02T08:00', end: '2026-03-02T16:00' })).data.id;
  assert.equal((await call('PUT', `/timesheets/${id}`, { start: '2026-03-02T05:00:00' }, pres.tok)).status, 403);
  assert.equal((await A('PUT', `/timesheets/${id}`, { start: 'n importe quoi' })).status, 400);
  assert.equal((await A('POST', '/attendance', { user_id: pres.id, start: '2026-03-02T09:00', end: '2026-03-02T10:00' })).status, 400, 'chevauchement refusé');
  // Rapport : une période absurde ne bloque plus le serveur
  const t0 = Date.now();
  assert.equal((await A('GET', '/attendance/report?from=2026-01-01&to=9999-12-31')).status, 400);
  assert.equal((await A('GET', '/attendance/report?from=2026-01-01&to=pasunedate')).status, 400);
  assert.ok(Date.now() - t0 < 2000);
  const rep = await A('GET', '/attendance/report?from=2026-03-02&to=2026-03-08');
  assert.equal(rep.data.find((r) => r.user_id === pres.id).worked, 8);
});
