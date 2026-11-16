// Historique des modifications : comme dans Odoo, la fiche d'un document garde chaque changement — qui l'a fait, quand,
// et ce qui a changé (ancienne valeur → nouvelle valeur, lignes ajoutées, retirées ou modifiées).
// Le test démarre un vrai serveur sur une base vide et passe par l'API.
process.env.TZ ||= 'Europe/Luxembourg';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 6200 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-history-'));
let server, admin, customer, other, vehicle, supplier;

async function call(method, url, body, tok) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* pas de JSON */ }
  return { status: res.status, data, text };
}
const A = (method, url, body) => call(method, url, body, admin);
const doc = async (id) => (await A('GET', '/documents/' + id)).data;
/** Les messages de l'historique d'une fiche, du plus ancien au plus récent. */
const history = async (model, id) => (await A('GET', `/chatter/${model}/${id}`)).data.messages.slice().reverse();
const changes = async (model, id) => (await history(model, id)).filter((m) => m.body.startsWith('✏️ Modification'));
async function userWith(perms, name) {
  const email = `${name.toLowerCase()}@t.lu`;
  await A('POST', '/users', { name, email, role: 'office', password: 'secret123', permissions: perms });
  return (await call('POST', '/auth/login', { email, password: 'secret123' })).data.token;
}

before(async () => {
  let out = '';
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', PUBLIC_URL: '', MAIL_TRANSPORT: 'json' }, stdio: 'pipe' });
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 80 && !/démarré/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  const r = await call('POST', '/auth/setup', { name: 'Gérant', email: 'g@t.lu', password: 'secret123', company: 'Garage Test' });
  assert.equal(r.status, 200, out);
  admin = r.data.token;
  customer = (await A('POST', '/customers', { name: 'Marc Weber' })).data.id;
  other = (await A('POST', '/customers', { name: 'Anne Klein' })).data.id;
  vehicle = (await A('POST', '/vehicles', { customer_id: customer, plate: 'HI 2026', make: 'Renault', model: 'Clio' })).data.id;
  supplier = (await A('POST', '/suppliers', { name: 'Pièces Auto Lux' })).data.id;
});
after(() => { server?.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('création et modification d’un OR : qui, et quoi (champs, lignes ajoutées, modifiées, retirées, total)', async () => {
  const id = (await A('POST', '/documents', { type: 'order', customer_id: customer, vehicle_id: vehicle, mileage: 125300, customer_complaint: 'Bruit au freinage',
    lines: [{ kind: 'labor', description: 'Vidange', quantity: 1, unit_price: 80, tax_rate: 17 }, { kind: 'part', description: 'Filtre à huile', quantity: 1, unit_price: 14.5, tax_rate: 17 }] })).data.id;
  let h = await history('document', id);
  assert.equal(h.length, 1);
  assert.equal(h[0].body, '📄 Ordre de réparation créé');
  assert.equal(h[0].user_name, 'Gérant');

  // enregistrer sans rien changer n'écrit rien
  let d = await doc(id);
  assert.equal((await A('PUT', '/documents/' + id, d)).status, 200);
  assert.equal((await changes('document', id)).length, 0);

  // un collègue change le kilométrage, la référence, une quantité et un prix, ajoute une ligne et en retire une
  const anna = await userWith({ atelier: 'user', ventes: 'user' }, 'Anna');
  d = await doc(id);
  const [vidange, filtre] = d.lines;
  const r = await call('PUT', '/documents/' + id, { ...d, mileage: 126000, reference: 'Sinistre 4471', customer_complaint: 'Bruit au freinage, surtout à froid',
    lines: [{ ...vidange, quantity: 1.5, unit_price: 85 }, { kind: 'part', description: 'Huile moteur 5W30', quantity: 5, unit_price: 16, tax_rate: 17 }] }, anna);
  assert.equal(r.status, 200, r.text);
  const c = await changes('document', id);
  assert.equal(c.length, 1);
  assert.equal(c[0].user_name, 'Anna', 'la modification est au nom de la personne qui l’a faite');
  assert.equal(c[0].kind, 'system');
  const b = c[0].body;
  assert.match(b, /• Kilométrage : 125[\s  .]300 km → 126[\s  .]000 km/);
  assert.match(b, /• Référence : \(vide\) → Sinistre 4471/);
  assert.match(b, /• Demande du client : ajout « , surtout à froid »/);
  assert.match(b, /• Ligne « Vidange » : quantité 1 → 1,5, prix unitaire 80,00 € → 85,00 €/);
  assert.match(b, /• Ligne ajoutée : Huile moteur 5W30 — 5 × 16,00 €/);
  assert.match(b, /• Ligne retirée : Filtre à huile — 1 × 14,50 €/);
  assert.match(b, /• Total TTC : 110,57 € → 242,78 €/);
  assert.ok(!/Statut|Client|Véhicule|Date/.test(b), 'seuls les champs changés sont cités : ' + b);
  assert.ok(filtre.id);
});

test('changement de client, de véhicule, de statut, de date et de mécanicien', async () => {
  const id = (await A('POST', '/documents', { type: 'order', customer_id: customer, vehicle_id: vehicle, lines: [{ kind: 'labor', description: 'Diagnostic', quantity: 1, unit_price: 60, tax_rate: 17 }] })).data.id;
  const car2 = (await A('POST', '/vehicles', { customer_id: other, plate: 'AK 77', make: 'Audi', model: 'A3' })).data.id;
  const mech = (await A('POST', '/users', { name: 'Paulo', role: 'mechanic', pin: '4321' })).data.id;
  const d = await doc(id);
  assert.equal((await A('PUT', '/documents/' + id, { ...d, customer_id: other, vehicle_id: car2, mechanic_id: mech, date: '2026-03-02', promised_at: '2026-03-04T17:00' })).status, 200);
  let b = (await changes('document', id)).at(-1).body;
  assert.match(b, /• Client : Marc Weber → Anne Klein/);
  assert.match(b, /• Véhicule : HI 2026 Renault Clio → AK 77 Audi A3/);
  assert.match(b, /• Mécanicien : \(vide\) → Paulo/);
  assert.match(b, /• Date : \d\d\/\d\d\/\d{4} → 02\/03\/2026/);
  assert.match(b, /• Promis pour : \(vide\) → 04\/03\/2026 17:00/);
  // statut changé par son bouton (ou en glissant la fiche sur le tableau de l'atelier)
  assert.equal((await A('POST', `/documents/${id}/status`, { status: 'in_progress' })).status, 200);
  b = (await changes('document', id)).at(-1).body;
  assert.equal(b, '✏️ Modification\n• Statut : À faire → En cours');
  // le même statut une deuxième fois : rien de plus
  const n = (await changes('document', id)).length;
  await A('POST', `/documents/${id}/status`, { status: 'in_progress' });
  assert.equal((await changes('document', id)).length, n);
});

test('à la tablette : ce que le mécanicien change est noté à son nom', async () => {
  const mech = (await A('POST', '/users', { name: 'Kevin', role: 'mechanic', pin: '4321' })).data.id;
  const tok = (await call('POST', '/kiosk/login', { user_id: mech, pin: '4321' })).data.token;
  assert.ok(tok);
  const id = (await A('POST', '/documents', { type: 'order', customer_id: customer, vehicle_id: vehicle, mechanic_id: mech, lines: [{ kind: 'labor', description: 'Contrôle freinage', quantity: 1, unit_price: 60, tax_rate: 17 }] })).data.id;
  const line = (await doc(id)).lines[0].id;
  const r = await call('POST', '/kiosk/orders/' + id, { line_id: line, done: true, diagnosis: 'Disques avant voilés', mileage: 131200, status: 'done' }, tok);
  assert.equal(r.status, 200, r.text);
  const c = (await changes('document', id)).at(-1);
  assert.equal(c.user_name, 'Kevin');
  assert.match(c.body, /• Statut : À faire → Terminé/);
  assert.match(c.body, /• Kilométrage : \(vide\) → 131[\s  .]200 km/);
  assert.match(c.body, /• Diagnostic : « Disques avant voilés »/);
  assert.match(c.body, /• Ligne « Contrôle freinage » : marquée « fait »/);
});

test('facture validée : seules les notes internes changent, et c’est noté', async () => {
  const id = (await A('POST', '/documents', { type: 'invoice', customer_id: customer, lines: [{ kind: 'labor', description: 'Vidange', quantity: 1, unit_price: 80, tax_rate: 17 }] })).data.id;
  assert.equal((await history('document', id))[0].body, '📄 Facture créée');
  assert.equal((await A('POST', `/documents/${id}/post`)).status, 200);
  const d = await doc(id);
  assert.equal((await A('PUT', '/documents/' + id, { ...d, internal_notes: 'Client à rappeler', reference: 'ne doit pas changer', lines: [] })).status, 200);
  const b = (await changes('document', id)).at(-1).body;
  assert.equal(b, '✏️ Modification\n• Notes internes : « Client à rappeler »');
  assert.equal((await doc(id)).lines.length, 1);
});

test('achats : modifications et étapes gardées dans l’historique', async () => {
  const id = (await A('POST', '/purchases', { supplier_id: supplier, reason: 'Réassort du stock', lines: [{ description: 'Disque de frein AV', quantity: 2, unit_price: 38, tax_rate: 17 }, { description: 'Plaquettes AV', quantity: 1, unit_price: 32, tax_rate: 17 }] })).data.id;
  let h = await history('purchase', id);
  assert.equal(h[0].body, '🛒 Achat créé');
  let p = (await A('GET', '/purchases/' + id)).data;
  // sans changement : rien
  assert.equal((await A('PUT', '/purchases/' + id, p)).status, 200);
  assert.equal((await changes('purchase', id)).length, 0);
  p = (await A('GET', '/purchases/' + id)).data;
  const [disque] = p.lines;
  const r = await A('PUT', '/purchases/' + id, { ...p, supplier_ref: 'FA-2026-118', due_date: '2026-12-15', lines: [{ ...disque, quantity: 4 }, { description: 'Liquide de frein', quantity: 1, unit_price: 9, tax_rate: 17 }] });
  assert.equal(r.status, 200, r.text);
  const b = (await changes('purchase', id)).at(-1).body;
  assert.match(b, /• N° de facture du fournisseur : \(vide\) → FA-2026-118/);
  assert.match(b, /• Échéance : \(vide\) → 15\/12\/2026/);
  assert.match(b, /• Ligne « Disque de frein AV » : quantité 2 → 4/);
  assert.match(b, /• Ligne ajoutée : Liquide de frein — 1 × 9,00 €/);
  assert.match(b, /• Ligne retirée : Plaquettes AV — 1 × 32,00 €/);
  assert.match(b, /• Total TTC : /);
  // les étapes : commande validée, facture comptabilisée, paiement
  assert.equal((await A('POST', `/purchases/${id}/order`, {})).status, 200);
  assert.equal((await A('POST', `/purchases/${id}/post`)).status, 200);
  h = await history('purchase', id);
  assert.ok(h.some((m) => m.body.startsWith('📦 Commande validée') && m.user_name === 'Gérant'));
  assert.ok(h.some((m) => m.body.startsWith('✔ Facture fournisseur comptabilisée')));
});

test('conversation par e-mail : la fiche dit à qui écrire, garde le texte envoyé ; les réglages de réception restent au gérant, sans mot de passe', async () => {
  const c = (await A('POST', '/customers', { name: 'Lea Braun', email: 'lea.braun@example.com' })).data.id;
  const id = (await A('POST', '/documents', { type: 'order', customer_id: c, lines: [{ kind: 'labor', description: 'Vidange', quantity: 1, unit_price: 80, tax_rate: 17 }] })).data.id;
  const number = (await doc(id)).number;
  let h = (await A('GET', `/chatter/document/${id}`)).data;
  assert.equal(h.contact.to, 'lea.braun@example.com');
  assert.ok(h.contact.subject.includes(number) && h.contact.subject.includes('Garage Test'), h.contact.subject);
  assert.deepEqual(h.inbox, { enabled: false, at: null, error: null });
  // un message court écrit depuis la fiche : il part par e-mail, sans le document, et son texte reste dans l'historique
  const r = await A('POST', '/mail/send', { model: 'document', record_id: id, to: h.contact.to, subject: h.contact.subject, intro: 'Bonjour, votre voiture est prête.', include_document: false });
  assert.equal(r.status, 200, r.text);
  h = (await A('GET', `/chatter/document/${id}`)).data;
  const m = h.messages.find((x) => x.kind === 'email');
  assert.equal(m.email_intro, 'Bonjour, votre voiture est prête.');
  assert.equal(m.email_to, 'lea.braun@example.com');
  assert.equal(m.email_with_doc, 0);
  assert.equal(h.contact.subject, (await A('GET', `/chatter/document/${id}`)).data.contact.subject);
  assert.equal((await doc(id)).mail_count, 0, 'un simple message n’est pas « le document envoyé par mail »');
  // réglages de la boîte de réception : réservés au gérant ; le mot de passe ne ressort nulle part
  const anna = await userWith({ atelier: 'user', emails: 'manager' }, 'Boite');
  assert.equal((await call('GET', '/mail/replies', undefined, anna)).status, 403);
  assert.equal((await call('PUT', '/mail/replies', { enabled: false }, anna)).status, 403);
  assert.equal((await call('POST', '/mail/replies/test', {}, anna)).status, 403);
  const saved = await A('PUT', '/mail/replies', { enabled: true, host: '127.0.0.1', port: 9, same_login: false, user: 'atelier@t.lu', pass: 'tres-secret-imap' });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.data.has_pass, true);
  for (const url of ['/mail/replies', '/settings', `/chatter/document/${id}`, '/mail/config']) assert.ok(!(await A('GET', url)).text.includes('tres-secret-imap'), url);
  assert.equal((await A('GET', `/chatter/document/${id}`)).data.inbox.enabled, true);
  // relève impossible (rien n'écoute à cette adresse — le test ne sort pas de la machine) : une erreur claire, pas de plantage — et la relève automatique est coupée ensuite
  const check = await A('POST', '/mail/replies/check');
  assert.equal(check.status, 400, check.text);
  assert.ok(check.data.error.length > 5);
  assert.equal((await A('PUT', '/mail/replies', { enabled: false })).status, 200);
});
