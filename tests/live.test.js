// Suivi en direct : liens, confidentialité, photos, étapes, accord client, temps réel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3600 + Math.floor(Math.random() * 90);
const ROOT = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-live-'));
let server, token;
const call = async (method, url, body, headers = {}) => {
  const r = await fetch(ROOT + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(d?.error || r.status), { status: r.status });
  return d;
};
const pub = (method, url, body, headers) => { const t = token; token = null; return call(method, url, body, headers).finally(() => { token = t; }); };

before(async () => {
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', MAIL_TRANSPORT: 'json' }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) { try { await fetch(`${ROOT}/api/auth/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  ({ token } = await call('POST', '/api/auth/setup', { name: 'Gérant', email: 'g@t.lu', password: 'secret123' }));
});
after(() => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('suivi en direct d\'un OR', async () => {
  const { id: cust } = await call('POST', '/api/customers', { name: 'Paul Hoffmann', email: 'paul@test.lu' });
  const { id: veh } = await call('POST', '/api/vehicles', { customer_id: cust, plate: 'PH 77', make: 'Audi', model: 'A3' });
  const { id: or } = await call('POST', '/api/documents', { type: 'order', customer_id: cust, vehicle_id: veh, customer_complaint: 'Bruit freins', lines: [{ kind: 'labor', description: 'Freins AV', quantity: 1, unit_price: 85, tax_rate: 17 }] });

  const { token: mech } = await call('POST', `/api/live/${or}/links`, { role: 'mechanic' });
  const { token: cli } = await call('POST', `/api/live/${or}/links`, { role: 'customer' });
  assert.equal((await call('POST', `/api/live/${or}/links`, { role: 'customer' })).token, cli); // même lien réutilisé

  // Temps réel : le client reçoit un événement quand le mécanicien publie
  const ctrl = new AbortController();
  const events = [];
  const sse = fetch(`${ROOT}/live-api/${cli}/events`, { signal: ctrl.signal }).then(async (r) => {
    const reader = r.body.getReader();
    for (;;) { const { value, done } = await reader.read(); if (done) break; events.push(new TextDecoder().decode(value)); }
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));

  // Mécanicien : message public, note interne, photo, étape
  await pub('POST', `/live-api/${mech}/posts`, { body: 'Disques voilés', name: 'Paulo' });
  await pub('POST', `/live-api/${mech}/posts`, { body: 'Client pénible', public: false, name: 'Paulo' });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');
  const { id: photo } = await pub('POST', `/live-api/${mech}/upload`, png, { 'Content-Type': 'image/png', 'X-Caption': encodeURIComponent('Disque avant') });
  const { id: secret } = await pub('POST', `/live-api/${mech}/upload`, png, { 'Content-Type': 'image/png', 'X-Public': '0' });
  await assert.rejects(pub('POST', `/live-api/${mech}/upload`, Buffer.from('x'), { 'Content-Type': 'application/zip' }), /Format/);
  await pub('POST', `/live-api/${mech}/stage`, { stage: 'diagnosis', name: 'Paulo' });

  // Côté client : pas de note interne, photo visible, photo interne inaccessible
  let c = await pub('GET', `/live-api/${cli}`);
  assert.equal(c.role, 'customer');
  assert.equal(c.order.plate, 'PH 77');
  assert.equal(c.stages[c.stage_index].key, 'diagnosis');
  assert.ok(c.posts.some((p) => p.body === 'Disques voilés'));
  assert.ok(!c.posts.some((p) => p.body === 'Client pénible'));
  assert.equal(c.lines, undefined);
  assert.equal((await fetch(`${ROOT}/live-api/${cli}/media/${photo}`)).status, 200);
  assert.equal((await fetch(`${ROOT}/live-api/${cli}/media/${secret}`)).status, 404);
  await assert.rejects(pub('POST', `/live-api/${cli}/stage`, { stage: 'ready' }), /refusé/);

  // Accord client : acceptation -> ligne ajoutée à l'OR
  const { id: ask } = await pub('POST', `/live-api/${mech}/posts`, { body: 'Remplacer les disques AV', kind: 'approval', amount: 117 });
  c = await pub('GET', `/live-api/${cli}`);
  assert.equal(c.stages[c.stage_index].key, 'approval');
  await pub('POST', `/live-api/${cli}/posts/${ask}/answer`, { answer: 'accepted' });
  await assert.rejects(pub('POST', `/live-api/${cli}/posts/${ask}/answer`, { answer: 'refused' }), /déjà répondu/);
  const doc = await call('GET', `/api/documents/${or}`);
  assert.equal(doc.lines.length, 2);
  assert.equal(doc.total, 216.45); // 85 HT + 100 HT, TVA 17 %
  const ch = await call('GET', `/api/chatter/document/${or}`);
  assert.ok(ch.messages.some((m) => /ACCEPTÉ/.test(m.body)));
  assert.equal(ch.activities.length, 1);

  // Message du client, visible au bureau
  await pub('POST', `/live-api/${cli}/posts`, { body: 'Merci !' });
  const office = await call('GET', `/api/live/${or}`);
  assert.ok(office.posts.some((p) => p.author_role === 'customer' && p.body === 'Merci !'));
  assert.ok(office.posts.some((p) => p.body === 'Client pénible'));
  assert.equal(office.links.length, 2);

  // Statut atelier "terminé" -> jauge à "prêt"
  await call('POST', `/api/documents/${or}/status`, { status: 'done' });
  c = await pub('GET', `/live-api/${cli}`);
  assert.equal(c.stages[c.stage_index].key, 'ready');

  // Mail de suivi prérempli avec le lien
  const m = await call('GET', `/api/mail/compose?model=document&id=${or}&template=live_tracking`);
  assert.match(m.intro, new RegExp(`suivi\\.html\\?t=${cli}`));

  // Lien révoqué
  await call('DELETE', `/api/live/${or}/links/customer`);
  await assert.rejects(pub('GET', `/live-api/${cli}`), /plus valide/);

  ctrl.abort();
  await sse;
  assert.ok(events.join('').includes('"type":"update"'));
});
