// Copilote Nova : commandes (avec actions), journal, résumé de fin de journée et priorités planifiées.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-nova-'));
const queue = [];
const seen = [];
const claude = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    seen.push(JSON.parse(b));
    const next = queue.shift();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, ...next }));
  });
});

let C, db, admin;
before(async () => {
  await new Promise((r) => claude.listen(0, r));
  Object.assign(process.env, { DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: `http://localhost:${claude.address().port}` });
  db = await import('../src/db.js');
  await import('../src/live.js'); // tables du suivi en direct
  await import('../src/bills.js'); // colonnes des factures fournisseurs
  C = await import('../src/copilot.js');
  admin = db.insert('users', { name: 'Tiago Gérant', email: 't@g.lu', role: 'admin' }, ['name', 'email', 'role']);
  const cust = db.insert('customers', { name: 'Jean Muller' }, ['name']);
  db.insert('vehicles', { customer_id: cust, plate: 'AB 1234' }, ['customer_id', 'plate']);
  db.insert('documents', { type: 'invoice', number: 'F2026-0001', status: 'posted', customer_id: cust, date: '2026-01-10', due_date: '2026-01-25', total: 250, amount_paid: 0 },
    ['type', 'number', 'status', 'customer_id', 'date', 'due_date', 'total', 'amount_paid']);
});
after(() => { claude.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('commande vocale : Nova agit avec ses outils', async () => {
  queue.push(
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'planifier_activite', input: { resume: 'Appeler le fournisseur de pneus', date: '2026-10-01', heure: '09:00', type: 'call', module: 'stock' } }, { type: 'tool_use', id: 't2', name: 'creer_rendez_vous', input: { client: 'AB1234', debut: '2026-10-02T14:00', motif: 'Pneus hiver' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'C\'est fait : rappel demain 9h et rendez-vous jeudi 14h pour M. Muller.' }] },
  );
  const user = db.get('SELECT * FROM users WHERE id=?', admin);
  const r = await C.copilotChat(user, 'Rappelle-moi d\'appeler le fournisseur de pneus et mets Muller jeudi 14h pour les pneus');
  assert.match(r.reply, /C'est fait/);
  assert.equal(r.actions.length, 2);
  assert.ok(db.get("SELECT * FROM activities WHERE summary='Appeler le fournisseur de pneus' AND due_date='2026-10-01' AND user_id=?", admin));
  const appt = db.get("SELECT * FROM appointments WHERE title='Pneus hiver'");
  assert.equal(appt.start, '2026-10-02T14:00');
  const tools = seen[0].tools.map((t) => t.name);
  assert.ok(tools.includes('noter_journal') && tools.includes('tableau_de_bord'));
  assert.match(seen[0].system[0].text, /Nova/);
});

test('journal + résumé de fin de journée avec priorités planifiées', async () => {
  C.addJournal('Le client de la Golf veut un devis pour les freins', admin, 'voice');
  const st = C.dayStats();
  assert.equal(st.journal.length, 1);
  assert.equal(st.factures_en_retard.length, 1);

  queue.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
    resume: '## Belle journée\nRien facturé, une facture en retard de 250 €.',
    priorites: [
      { resume: 'Relancer Jean Muller pour F2026-0001', pourquoi: '250 € en retard', echeance: '2099-01-02', type: 'payment', module: 'comptabilite' },
      { resume: 'Envoyer le devis freins de la Golf', pourquoi: 'Demande du client', echeance: '2099-01-02', type: 'email', module: 'ventes' },
    ],
  }) }] });
  const b = await C.generateBrief({ force: true });
  assert.equal(b.ai, 1);
  assert.equal(b.created, 2);
  assert.ok(db.get("SELECT * FROM activities WHERE summary='🧠 Relancer Jean Muller pour F2026-0001'"));
  const req = seen.at(-1);
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.match(req.messages[0].content, /devis pour les freins/); // le journal est transmis
  assert.equal(C.listBriefs()[0].priorities.length, 2);

  // Relancé : pas de doublon d'activités
  queue.push({ stop_reason: 'end_turn', content: seen.length && [{ type: 'text', text: JSON.stringify({ resume: 'x', priorites: [{ resume: 'Relancer Jean Muller pour F2026-0001', pourquoi: 'y', echeance: '2099-01-02', type: 'payment', module: 'comptabilite' }] }) }] });
  assert.equal((await C.generateBrief({ force: true })).created, 0);

  // Sans IA : résumé chiffré + priorités par règles
  delete process.env.ANTHROPIC_API_KEY;
  const plain = await C.generateBrief({ date: '2026-01-26', force: true });
  assert.equal(plain.ai, 0);
  assert.match(plain.content, /Impayés/);
  assert.ok(JSON.parse(plain.priorities).some((p) => /Relancer/.test(p.resume)));
  process.env.ANTHROPIC_API_KEY = 'test';
});
