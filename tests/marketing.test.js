// CRM, site web (rendu sûr, formulaire → opportunité) et marketing social (publication Facebook simulée).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-mkt-'));
let db, CRM, W, S;
before(async () => {
  Object.assign(process.env, { DATA_DIR: dataDir, MAIL_TRANSPORT: 'json' });
  delete process.env.ANTHROPIC_API_KEY;
  db = await import('../src/db.js');
  await import('../src/live.js');
  await import('../src/bills.js');
  CRM = await import('../src/crm.js');
  W = await import('../src/website.js');
  S = await import('../src/social.js');
  db.insert('users', { name: 'Gérant', email: 'g@g.lu', role: 'admin' }, ['name', 'email', 'role']);
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('CRM : pipeline, gagné / perdu, devis avec client et véhicule', () => {
  const st = CRM.stages();
  assert.equal(st.length, 5);
  const id = CRM.saveLead({ contact_name: 'Marc Weber', phone: '621 000 111', service: 'Distribution', vehicle_plate: 'ab 1234', expected_revenue: 890 });
  const l = CRM.getLead(id);
  assert.equal(l.name, 'Distribution — Marc Weber');
  assert.equal(l.stage_id, st[0].id);
  CRM.moveLead(id, st[2].id);
  assert.equal(CRM.getLead(id).probability, st[2].probability);
  const docId = CRM.createQuote(id);
  const doc = db.get('SELECT * FROM documents WHERE id=?', docId);
  assert.equal(doc.type, 'quote');
  assert.equal(db.get('SELECT name FROM customers WHERE id=?', doc.customer_id).name, 'Marc Weber');
  assert.equal(db.get('SELECT plate FROM vehicles WHERE id=?', doc.vehicle_id).plate, 'AB 1234');
  assert.equal(CRM.createQuote(id), docId); // pas de doublon
  assert.equal(CRM.markWon(id).status, 'won');
  const id2 = CRM.saveLead({ name: 'Pneus', expected_revenue: 400 });
  assert.equal(CRM.markLost(id2, 'Trop cher').status, 'lost');
  const s = CRM.pipelineStats();
  assert.equal(s.win_rate, 50);
  assert.equal(CRM.restoreLead(id2).status, 'open');
  // Déplacer vers « Gagné » via la fiche marque aussi l'opportunité gagnée
  CRM.saveLead({ stage_id: st.at(-1).id }, id2);
  assert.equal(CRM.getLead(id2).status, 'won');
});

test('site : contenu nettoyé et échappé, pas de faux avis par défaut', () => {
  const def = W.websiteConfig();
  assert.ok(def.blocks.find((b) => b.type === 'reviews').hidden);
  assert.ok(def.blocks.find((b) => b.type === 'services').items.every((i) => !i.price));
  const saved = W.saveWebsite({
    blocks: [
      { type: 'hero', title: '<script>alert(1)</script>Bienvenue', subtitle: 'x', image: 'javascript:alert(1)' },
      { type: 'about', title: 'À propos', text: 'ok', image: '/site-media/0123456789abcdef01234567.png' },
      { type: 'inconnu', title: 'x' },
      { type: 'contact', title: 'Contact' },
    ],
    accent: 'red;}', theme: 'light',
  });
  assert.equal(saved.blocks.length, 3);
  assert.equal(saved.blocks[0].image, '');
  assert.equal(saved.blocks[1].image, '/site-media/0123456789abcdef01234567.png');
  const html = W.renderSite();
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;Bienvenue'));
  assert.ok(!html.includes('red;}'));
});

test('site : formulaire de contact → opportunité + activité, anti-robots', () => {
  assert.throws(() => W.submitContact({ name: 'A', phone: '1' }, '1.1.1.1'), /non publié/);
  W.saveWebsite({ published: true });
  assert.throws(() => W.submitContact({ name: 'Sans contact' }, '1.1.1.1'), /téléphone ou un e-mail/);
  assert.deepEqual(W.submitContact({ name: 'Robot', phone: '1', website: 'spam' }, '1.1.1.2'), { ok: true });
  assert.equal(db.get("SELECT COUNT(*) n FROM crm_leads WHERE contact_name='Robot'").n, 0);
  W.submitContact({ name: 'Carla Pereira', phone: '+352 691 123 456', plate: 'zz 42', service: 'Freinage', message: 'Bruit', date: '2026-10-02' }, '1.1.1.3');
  const lead = db.get("SELECT * FROM crm_leads WHERE contact_name='Carla Pereira'");
  assert.equal(lead.source, 'site');
  assert.equal(lead.vehicle_plate, 'ZZ 42');
  assert.equal(lead.deadline, '2026-10-02');
  assert.ok(db.get("SELECT * FROM activities WHERE model='lead' AND record_id=?", lead.id));
  for (let i = 0; i < 5; i++) W.submitContact({ name: 'X' + i, phone: '1' }, '9.9.9.9');
  assert.throws(() => W.submitContact({ name: 'X6', phone: '1' }, '9.9.9.9'), /Trop de demandes/);
});

test('social : validation, publication Facebook (API simulée) et réseaux à la main', async () => {
  assert.throws(() => S.savePost({ text: '', platforms: ['facebook'] }, 1), /vide/);
  assert.throws(() => S.savePost({ text: 'x', platforms: ['instagram'] }, 1), /image/);
  const id = S.savePost({ text: 'Pneus hiver : prenez rendez-vous', platforms: ['facebook', 'google'] }, 1);
  let r = await S.publishPost(id, '');
  assert.equal(r.status, 'error'); // page non connectée
  assert.match(r.results.facebook.error, /non connectée/);
  assert.equal(r.results.google.manual, true);

  S.saveAccounts({ facebook: { page_id: '123456789', token: 'SECRET', name: 'Garage' } });
  assert.deepEqual(S.publicAccounts().facebook, { connected: true, name: 'Garage' });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return new Response(JSON.stringify({ id: '123_456' }), { status: 200 }); };
  try {
    r = await S.publishPost(id, '');
    assert.equal(r.status, 'partial'); // Facebook publié, Google à faire à la main
    assert.equal(calls[0][0], 'https://graph.facebook.com/v21.0/123456789/feed');
    assert.equal(calls[0][1].message, 'Pneus hiver : prenez rendez-vous');
    assert.equal(S.markManualDone(id).status, 'published');
    // Programmée dans le passé → publiée par le planificateur
    const id2 = S.savePost({ text: 'Programmée', platforms: ['facebook'], scheduled_at: '2020-01-01T10:00' }, 1);
    assert.equal(S.getPost(id2).status, 'scheduled');
    assert.equal(await S.publishDue(''), 1);
    assert.equal(S.getPost(id2).status, 'published');
  } finally { globalThis.fetch = realFetch; }
  assert.throws(() => S.savePost({ text: 'y' }, 1, id), /réseau/);
});
