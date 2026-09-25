// E-mails (envoi, programmation, annulation), historique et activités récurrentes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3700 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-mail-'));
let server, token;
const call = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error);
  return d;
};

before(async () => {
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', MAIL_TRANSPORT: 'json' }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/auth/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const r = await fetch(`${BASE}/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Gérant', email: 'g@t.lu', password: 'secret123' }) });
  ({ token } = await r.json());
});
after(() => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('e-mails, historique et activités', async () => {
  await call('PUT', '/settings', { company: { name: 'Garage Test', iban: 'LU28 0019 4006 4475 0000', bic: 'BCEELULL' } });
  await call('PUT', '/mail/config', { from_email: 'info@garage.lu', from_name: 'Garage Test', pass: 'secret' });
  assert.equal((await call('GET', '/mail/config')).pass, undefined); // mot de passe jamais renvoyé

  const { id: cust } = await call('POST', '/customers', { name: 'Anne Klein', email: 'anne@test.lu' });
  const { id: inv } = await call('POST', '/documents', { type: 'invoice', customer_id: cust, lines: [{ kind: 'labor', description: 'Vidange', quantity: 1, unit_price: 100, tax_rate: 17 }] });
  await call('POST', `/documents/${inv}/post`);

  // Modèle "facture" prérempli
  const c = await call('GET', `/mail/compose?model=document&id=${inv}`);
  assert.equal(c.to, 'anne@test.lu');
  assert.match(c.subject, /^Facture F\d{4}-0001/);
  assert.equal(c.include_document, true);
  assert.ok(c.templates.some((t) => t.key === 'invoice_reminder'));
  const prev = await call('POST', '/mail/preview', { model: 'document', record_id: inv, intro: c.intro, include_document: true });
  assert.match(prev.html, /117,00/);
  assert.match(prev.html, /qr\.svg/);

  // Envoi immédiat
  const sent = await call('POST', '/mail/send', { model: 'document', record_id: inv, to: c.to, subject: c.subject, intro: c.intro, include_document: true });
  assert.equal(sent.status, 'sent');

  // Envoi programmé puis annulé
  const later = new Date(Date.now() + 86400e3).toISOString().slice(0, 16);
  const sch = await call('POST', '/mail/send', { model: 'document', record_id: inv, to: c.to, subject: 'Relance', intro: 'Bonjour', scheduled_at: later });
  assert.equal(sch.status, 'scheduled');
  let ch = await call('GET', `/chatter/document/${inv}`);
  assert.equal(ch.scheduled.length, 1);
  await call('DELETE', `/mail/${sch.id}`);
  ch = await call('GET', `/chatter/document/${inv}`);
  assert.equal(ch.scheduled.length, 0);
  assert.ok(ch.messages.some((m) => m.kind === 'email' && /envoyé à anne@test.lu/.test(m.body)));
  assert.ok(ch.messages.some((m) => /Validée sous le numéro/.test(m.body)));

  // Note interne
  await call('POST', `/chatter/document/${inv}/note`, { body: 'Client prévenu par téléphone' });

  // Activité récurrente sur la fiche + activité de module sans fiche
  const { id: act } = await call('POST', '/activities', { model: 'document', record_id: inv, type: 'payment', summary: 'Vérifier le paiement', due_date: '2020-01-01', recurrence: 'monthly' });
  await call('POST', '/activities', { module: 'stock', type: 'order', summary: 'Inventaire des pneus', due_date: '2099-01-01' });
  let counts = await call('GET', '/activities/counts');
  assert.equal(counts.late, 1);
  assert.equal(counts.upcoming, 1);
  assert.equal((await call('GET', '/activities?module=stock')).length, 1);
  const done = await call('POST', `/activities/${act}/done`, { feedback: 'Payé' });
  assert.equal(done.next, '2020-02-01'); // prochaine occurrence créée
  const mine = await call('GET', '/activities?mine=1');
  assert.equal(mine.length, 2);
  assert.equal(mine.find((a) => a.model === 'document').record.link, `/document/${inv}`);

  // Sans adresse : refus clair
  await assert.rejects(call('POST', '/mail/send', { to: '', subject: 'x', intro: 'y' }), /Adresse/);
  const outbox = await call('GET', '/mail/outbox');
  assert.deepEqual(outbox.map((e) => e.status).sort(), ['cancelled', 'sent']);
});
