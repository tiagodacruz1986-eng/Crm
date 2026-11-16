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

// ---------- Suites de la relecture : ce que l'historique ne notait pas encore ----------
const lastChange = async (model, id) => (await changes(model, id)).at(-1);
const bodies = async (model, id) => (await history(model, id)).map((m) => m.body);
const order = async (extra = {}) => (await A('POST', '/documents', { type: 'order', customer_id: customer, vehicle_id: vehicle, lines: [{ kind: 'labor', description: 'Vidange', quantity: 1, unit_price: 100, tax_rate: 17 }], ...extra })).data.id;

test('texte long modifié : on lit ce qui a changé (et non deux fois le même début tronqué)', async () => {
  const n1 = '[Paulo 2026-11-16 20:36] Disques AV à la cote mini, le client a refusé le remplacement par téléphone.';
  const n2 = '[Paulo 2026-11-16 21:02] Rayure constatée sur l’aile arrière gauche AVANT les travaux (photo prise).';
  const id = await order({ internal_notes: `${n1}\n${n2}` });
  let d = await doc(id);
  assert.equal((await A('PUT', '/documents/' + id, { ...d, internal_notes: `${n1}\nRAS.` })).status, 200);
  let b = (await lastChange('document', id)).body;
  const m = /• Notes internes : « (.*) » → « (.*) »/.exec(b);
  assert.ok(m, b);
  assert.notEqual(m[1], m[2]);
  assert.match(m[1], /Rayure constatée sur l’aile arrière gauche/);
  assert.match(m[2], /RAS\./);
  // la deuxième note supprimée : son texte est gardé dans l'historique
  d = await doc(id);
  assert.equal((await A('PUT', '/documents/' + id, { ...d, internal_notes: `${n1}\n${n2}` })).status, 200);
  d = await doc(id);
  assert.equal((await A('PUT', '/documents/' + id, { ...d, internal_notes: n1 })).status, 200);
  b = (await lastChange('document', id)).body;
  assert.match(b, /• Notes internes : retiré « .*Rayure constatée.*photo prise\)\. »/);
  // désignation longue corrigée vers la fin
  d = await doc(id);
  const long = 'Remplacement du kit de distribution complet avec pompe à eau et galets tendeurs, référence KD457.71';
  assert.equal((await A('PUT', '/documents/' + id, { ...d, lines: [{ ...d.lines[0], description: long }] })).status, 200);
  d = await doc(id);
  assert.equal((await A('PUT', '/documents/' + id, { ...d, lines: [{ ...d.lines[0], description: long.replace('KD457.71', 'KD457.73') }] })).status, 200);
  b = (await lastChange('document', id)).body;
  assert.match(b, /désignation « … .*KD457\.71 » → « … .*KD457\.73 »/);
});

test('une référence qui ne change que par ses zéros est bien notée ; un nombre identique ne l’est pas', async () => {
  const id = await order({ reference: '00123' });
  let d = await doc(id);
  assert.equal((await A('PUT', '/documents/' + id, { ...d, reference: '123' })).status, 200);
  assert.match((await lastChange('document', id)).body, /• Référence : 00123 → 123/);
  const n = (await changes('document', id)).length;
  d = await doc(id);
  // mêmes valeurs envoyées sous forme de texte : rien de nouveau
  assert.equal((await A('PUT', '/documents/' + id, { ...d, lines: d.lines.map((l) => ({ ...l, quantity: '1', unit_price: '100.00', discount: '' })) })).status, 200);
  assert.equal((await changes('document', id)).length, n);
});

test('plus de trente lignes modifiées d’un coup : les premières sont citées, le total reste', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => ({ kind: 'part', description: `Pièce n° ${i + 1}`, quantity: 1, unit_price: 10, tax_rate: 17 }));
  const id = (await A('POST', '/documents', { type: 'order', customer_id: customer, lines })).data.id;
  const d = await doc(id);
  assert.equal((await A('PUT', '/documents/' + id, { ...d, reference: 'Lot', lines: d.lines.map((l) => ({ ...l, unit_price: 11 })) })).status, 200);
  const b = (await lastChange('document', id)).body;
  assert.match(b, /• Référence : \(vide\) → Lot/);
  assert.match(b, /• … et 10 autres lignes modifiées/);
  assert.match(b, /• Total TTC : 468,00 € → 514,80 €/);
  assert.equal(b.split('\n').length, 1 + 1 + 30 + 1 + 1);
});

test('démarrer le chrono : le passage « En cours » et le mécanicien sont notés', async () => {
  const mech = (await A('POST', '/users', { name: 'Sven', role: 'mechanic', pin: '4321' })).data.id;
  const tok = (await call('POST', '/kiosk/login', { user_id: mech, pin: '4321' })).data.token;
  const id = await order();
  const r = await call('POST', '/kiosk/clock', { action: 'start', document_id: id }, tok);
  assert.equal(r.status, 200, r.text);
  const c = await lastChange('document', id);
  assert.equal(c.user_name, 'Sven');
  assert.match(c.body, /• Statut : À faire → En cours/);
  assert.match(c.body, /• Mécanicien : \(vide\) → Sven/);
  // le chrono relancé sur le même OR n'ajoute rien
  const n = (await changes('document', id)).length;
  await call('POST', '/kiosk/clock', { action: 'start', document_id: id }, tok);
  assert.equal((await changes('document', id)).length, n);
  // lancé par le bureau pour le mécanicien, sur un OR « Terminé » : noté au nom de la personne du bureau
  await call('POST', '/kiosk/clock', { action: 'stop' }, tok);
  assert.equal((await A('POST', `/documents/${id}/status`, { status: 'done' })).status, 200);
  const o = await A('POST', `/documents/${id}/clock`, { action: 'start', user_id: mech });
  assert.equal(o.status, 200, o.text);
  const c2 = await lastChange('document', id);
  assert.equal(c2.user_name, 'Gérant');
  assert.match(c2.body, /• Statut : Terminé → En cours/);
});

test('paiement par rapprochement bancaire, note de crédit, facture brouillon supprimée : la fiche concernée le dit', async () => {
  // facture payée par l'import d'un relevé bancaire
  const inv = (await A('POST', '/documents', { type: 'invoice', customer_id: customer, lines: [{ kind: 'labor', description: 'Vidange', quantity: 1, unit_price: 100, tax_rate: 17 }] })).data.id;
  const number = (await A('POST', `/documents/${inv}/post`)).data.number;
  const acc = (await A('POST', '/bank-accounts', { name: 'Compte courant', account_code: '5131' })).data.id;
  const imp = await A('POST', `/bank/import/${acc}`, { content: `Date;Montant;Communication\n${new Date().toLocaleDateString('fr-FR')};117,00;Paiement facture ${number}\n` });
  assert.equal(imp.status, 200, imp.text);
  assert.equal((await doc(inv)).status, 'paid', JSON.stringify(imp.data));
  let h = await history('document', inv);
  const paid = h.find((m) => m.body.startsWith('💶 Paiement enregistré par rapprochement bancaire'));
  assert.ok(paid, h.map((m) => m.body).join(' | '));
  assert.match(paid.body, /117\.00 €/);
  assert.equal(paid.user_name, 'Gérant');
  // rapprochement défait : noté aussi
  const line = (await A('GET', '/bank/lines')).data.find((l) => l.status === 'matched');
  assert.ok(line);
  assert.equal((await A('POST', `/bank/lines/${line.id}/unmatch`)).status, 200);
  assert.ok((await bodies('document', inv)).some((b) => /^↩️ Paiement de 117\.00 € annulé \(rapprochement bancaire défait\)/.test(b)));
  assert.equal((await doc(inv)).status, 'posted');
  // note de crédit validée : la facture d'origine dit pourquoi elle est soldée
  const cn = (await A('POST', `/documents/${inv}/convert`, { type: 'credit_note' })).data.id;
  const cnNumber = (await A('POST', `/documents/${cn}/post`)).data.number;
  assert.ok((await bodies('document', inv)).some((b) => b === `🧾 Note de crédit ${cnNumber} validée : 117.00 € imputés sur cette facture`), (await bodies('document', inv)).join(' | '));
  // facture brouillon d'un OR supprimée : l'OR le note
  const or = await order();
  assert.equal((await A('POST', `/documents/${or}/status`, { status: 'done' })).status, 200);
  const draft = (await A('POST', `/documents/${or}/convert`, { type: 'invoice' })).data.id;
  assert.equal((await doc(or)).status, 'invoiced');
  assert.equal((await A('DELETE', '/documents/' + draft)).status, 200);
  assert.equal((await doc(or)).status, 'done');
  h = await history('document', or);
  assert.ok(h.some((m) => m.body.startsWith('🗑 Facture en brouillon supprimée') && m.user_name === 'Gérant'), h.map((m) => m.body).join(' | '));
});

test('fiches créées hors de l’éditeur (rendez-vous, réassort) et zones personnalisées : qui, et quoi', async () => {
  const start = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const ap = await A('POST', '/appointments', { customer_id: customer, vehicle_id: vehicle, title: 'Révision', start: `${start}T09:00`, end: `${start}T10:00` });
  assert.equal(ap.status, 200, ap.text);
  const or = (await A('POST', `/appointments/${ap.data.id}/order`)).data.id;
  let h = await history('document', or);
  assert.equal(h[0].body, '📄 Ordre de réparation créé depuis le rendez-vous (arrivée du véhicule)');
  assert.equal(h[0].user_name, 'Gérant');
  // réassort automatique
  await A('POST', '/products', { ref: 'RS-1', name: 'Filtre à air', supplier_id: supplier, qty_min: 2, purchase_price: 8, sale_price: 18, tax_rate: 17 });
  const re = await A('POST', '/stock/reorder');
  assert.equal(re.status, 200, re.text);
  const hp = await history('purchase', re.data.created[0]);
  assert.equal(hp[0].body, '🛒 Achat créé par « Commander le stock bas »');
  assert.equal(hp[0].user_name, 'Gérant');
  assert.ok(hp.some((m) => /raison : Réassort du stock/.test(m.body)));
  // zone personnalisée de la fiche OR
  const f = (await A('POST', '/studio/fields', { target: 'order', kind: 'text', label: 'N° de sinistre' })).data.id;
  assert.ok(f);
  assert.equal((await A('PUT', `/studio/record/document/${or}`, { values: { [f]: 'A-1' } })).status, 200);
  assert.equal((await lastChange('document', or)).body, '✏️ Modification\n• N° de sinistre : (vide) → A-1');
  assert.equal((await A('PUT', `/studio/record/document/${or}`, { values: { [f]: 'A-2' } })).status, 200);
  assert.equal((await lastChange('document', or)).body, '✏️ Modification\n• N° de sinistre : A-1 → A-2');
  const n = (await changes('document', or)).length;
  assert.equal((await A('PUT', `/studio/record/document/${or}`, { values: { [f]: 'A-2' } })).status, 200);
  assert.equal((await changes('document', or)).length, n);
});
