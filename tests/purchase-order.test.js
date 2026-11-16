// Bons de commande : à la validation, la commande doit dire pour quel ordre de réparation elle est faite — ou, si ce
// n'est pas pour un OR, pourquoi. Sur l'OR, on retrouve toutes les commandes faites pour lui.
// Le test démarre un vrai serveur sur une base vide et passe par l'API.
process.env.TZ ||= 'Europe/Luxembourg';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 6100 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-purchase-order-'));
let server, admin, customer, vehicle, supplier;

async function call(method, url, body, tok) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* pas de JSON */ }
  return { status: res.status, data, text };
}
const A = (method, url, body) => call(method, url, body, admin);
const doc = async (type = 'order') => (await A('POST', '/documents', { type, customer_id: customer, vehicle_id: vehicle, lines: [{ kind: 'labor', description: 'Vidange', quantity: 1, unit_price: 80, tax_rate: 17 }] })).data.id;
const buy = async (extra = {}) => (await A('POST', '/purchases', { supplier_id: supplier, lines: [{ description: 'Disque de frein AV', quantity: 2, unit_price: 38, tax_rate: 17 }, { description: 'Plaquettes AV', quantity: 1, unit_price: 32, tax_rate: 17 }], ...extra })).data.id;
const purchase = async (id) => (await A('GET', '/purchases/' + id)).data;
async function userWith(perms, name) {
  const email = `${name}@t.lu`;
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
  vehicle = (await A('POST', '/vehicles', { customer_id: customer, plate: 'XY 4321', make: 'Renault', model: 'Clio' })).data.id;
  supplier = (await A('POST', '/suppliers', { name: 'Pièces Auto Lux' })).data.id;
});
after(() => { server?.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('un bon de commande ne se valide pas sans dire pour quoi il est fait', async () => {
  const id = await buy();
  let p = await purchase(id);
  assert.equal(p.status, 'draft');
  assert.equal(p.document_id, null);
  assert.equal(p.reason, null);
  const r = await A('POST', `/purchases/${id}/order`, {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /ordre de réparation/);
  assert.match(r.data.error, /raison/);
  // (un appel sans corps du tout est refusé de la même façon)
  assert.equal((await A('POST', `/purchases/${id}/order`)).status, 400);
  p = await purchase(id);
  assert.equal(p.status, 'draft', 'la commande reste en brouillon');
});

test('commande validée pour un ordre de réparation : on la retrouve sur l’OR', async () => {
  const or = await doc('order');
  const orNumber = (await A('GET', '/documents/' + or)).data.number;
  const id = await buy();
  assert.deepEqual((await A('GET', `/documents/${or}/purchases`)).data, []);
  const r = await A('POST', `/purchases/${id}/order`, { document_id: or });
  assert.equal(r.status, 200, r.text);
  const p = await purchase(id);
  assert.equal(p.status, 'ordered');
  assert.equal(p.document_id, or);
  assert.equal(p.reason, null);
  assert.equal(p.order_number, orNumber);
  assert.equal(p.order_plate, 'XY 4321');
  assert.equal(p.order_customer, 'Marc Weber');
  assert.equal(p.order_vehicle, 'Renault Clio');
  // sur l'OR : numéro, fournisseur, statut, total, et un aperçu de ce qui a été commandé
  const list = (await A('GET', `/documents/${or}/purchases`)).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].number, p.number);
  assert.equal(list[0].supplier_name, 'Pièces Auto Lux');
  assert.equal(list[0].status, 'ordered');
  assert.equal(list[0].total, p.total);
  assert.equal(list[0].line_count, 2);
  assert.match(list[0].items, /Disque de frein AV × 2 · Plaquettes AV/);
  // la liste des achats le dit aussi
  const row = (await A('GET', '/purchases')).data.find((x) => x.id === id);
  assert.equal(row.order_number, orNumber);
  assert.equal(row.order_plate, 'XY 4321');
  // et l'historique des deux fiches en garde la trace
  assert.ok((await A('GET', `/chatter/purchase/${id}`)).data.messages.some((m) => m.body.includes(orNumber)));
  assert.ok((await A('GET', `/chatter/document/${or}`)).data.messages.some((m) => m.body.includes(p.number)));
  // une deuxième commande pour le même OR s'ajoute à la liste
  const second = await buy();
  assert.equal((await A('POST', `/purchases/${second}/order`, { document_id: or })).status, 200);
  assert.deepEqual((await A('GET', `/documents/${or}/purchases`)).data.map((x) => x.id), [id, second]);
});

test('commande qui n’est pas pour un OR : la raison est obligatoire', async () => {
  const id = await buy();
  for (const reason of ['', '   ', 'ab', null]) {
    const r = await A('POST', `/purchases/${id}/order`, { reason });
    assert.equal(r.status, 400, `raison ${JSON.stringify(reason)} refusée`);
  }
  assert.equal((await purchase(id)).status, 'draft');
  const r = await A('POST', `/purchases/${id}/order`, { reason: '  Réassort   du stock  ' });
  assert.equal(r.status, 200, r.text);
  const p = await purchase(id);
  assert.equal(p.status, 'ordered');
  assert.equal(p.document_id, null);
  assert.equal(p.reason, 'Réassort du stock');
  assert.equal(p.order_number, null);
  assert.ok((await A('GET', `/chatter/purchase/${id}`)).data.messages.some((m) => m.body.includes('Réassort du stock')));
  // une raison très longue est raccourcie, pas refusée
  const long = await buy();
  assert.equal((await A('POST', `/purchases/${long}/order`, { reason: 'x'.repeat(900) })).status, 200);
  assert.equal((await purchase(long)).reason.length, 300);
});

test('une commande ne se rattache qu’à un ordre de réparation qui existe', async () => {
  const id = await buy();
  const quote = await doc('quote');
  const invoice = await doc('invoice');
  for (const document_id of [quote, invoice, 999999]) {
    const r = await A('POST', `/purchases/${id}/order`, { document_id });
    assert.equal(r.status, 400, `document ${document_id} refusé`);
    assert.match(r.data.error, /Ordre de réparation introuvable/);
  }
  const p = await purchase(id);
  assert.equal(p.status, 'draft');
  assert.equal(p.document_id, null);
  assert.equal((await A('POST', '/purchases/999999/order', { reason: 'Outillage' })).status, 404);
  assert.equal((await A('POST', '/purchases/999999/assign', { reason: 'Outillage' })).status, 404);
});

test('on peut préciser ou changer l’affectation à tout moment', async () => {
  const a = await doc('order'), b = await doc('order');
  const id = await buy();
  // précisée avant la validation : la validation ne redemande rien
  let r = await A('POST', `/purchases/${id}/assign`, { document_id: a });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.document_id, a);
  assert.equal(r.data.status, 'draft');
  assert.equal((await A('POST', `/purchases/${id}/order`, {})).status, 200);
  assert.equal((await purchase(id)).status, 'ordered');
  // changée pour un autre OR : elle quitte le premier
  r = await A('POST', `/purchases/${id}/assign`, { document_id: b });
  assert.equal(r.data.document_id, b);
  assert.deepEqual((await A('GET', `/documents/${a}/purchases`)).data, []);
  assert.equal((await A('GET', `/documents/${b}/purchases`)).data.length, 1);
  const p = await purchase(id);
  assert.ok((await A('GET', `/chatter/document/${a}`)).data.messages.some((m) => m.body.includes(p.number) && /retiré/.test(m.body)));
  // puis « pas pour un OR » : la raison remplace l'OR
  r = await A('POST', `/purchases/${id}/assign`, { reason: 'Finalement pour le stock' });
  assert.equal(r.data.document_id, null);
  assert.equal(r.data.reason, 'Finalement pour le stock');
  assert.deepEqual((await A('GET', `/documents/${b}/purchases`)).data, []);
  // ni l'un ni l'autre : refusé, rien ne change
  assert.equal((await A('POST', `/purchases/${id}/assign`, {})).status, 400);
  assert.equal((await purchase(id)).reason, 'Finalement pour le stock');
  // l'enregistrement de l'achat ne touche pas à l'affectation
  const cur = await purchase(id);
  assert.equal((await A('PUT', '/purchases/' + id, { ...cur, document_id: a, reason: 'autre chose', notes: 'note' })).status, 200);
  assert.equal((await purchase(id)).reason, 'Finalement pour le stock');
  assert.equal((await purchase(id)).document_id, null);
});

test('commande créée depuis un OR : elle lui est rattachée dès l’enregistrement', async () => {
  const or = await doc('order');
  const id = await buy({ document_id: or });
  const p = await purchase(id);
  assert.equal(p.document_id, or);
  assert.equal(p.status, 'draft');
  assert.equal((await A('GET', `/documents/${or}/purchases`)).data[0].status, 'draft');
  assert.equal((await A('POST', `/purchases/${id}/order`, {})).status, 200);
  // depuis un document qui n'est pas un OR : rien n'est créé
  const before = (await A('GET', '/purchases')).data.length;
  const quote = await doc('quote');
  assert.equal((await A('POST', '/purchases', { supplier_id: supplier, document_id: quote, lines: [] })).status, 400);
  assert.equal((await A('GET', '/purchases')).data.length, before);
});

test('recherche de l’OR à rattacher : numéro, plaque (avec ou sans espace), client, véhicule', async () => {
  const or = await doc('order');
  const number = (await A('GET', '/documents/' + or)).data.number;
  for (const q of [number, 'XY 4321', 'xy4321', 'weber', 'clio']) {
    const found = (await A('GET', '/purchases/orders?q=' + encodeURIComponent(q))).data;
    assert.ok(found.some((o) => o.id === or), `trouvé avec « ${q} »`);
    assert.ok(found.every((o) => o.number && 'status' in o && !('total' in o)), 'seulement de quoi reconnaître l’OR');
  }
  assert.deepEqual((await A('GET', '/purchases/orders?q=introuvable-zzz')).data, []);
  assert.deepEqual((await A('GET', '/purchases/orders?q=' + encodeURIComponent('%'))).data, [], 'le signe % ne ramène pas tout');
  // sans recherche : les OR, jamais les devis ni les factures
  const quote = await doc('quote');
  const all = (await A('GET', '/purchases/orders')).data;
  assert.ok(all.length >= 1 && !all.some((o) => o.id === quote));
  assert.equal((await A('GET', '/purchases/orders?id=' + or)).data[0].number, number);
  assert.deepEqual((await A('GET', '/purchases/orders?id=' + quote)).data, []);
});

test('droits : valider ou affecter demande le niveau utilisateur sur les achats ; sur l’OR, les montants demandent de lire les achats', async () => {
  const or = await doc('order');
  const id = await buy();
  const reader = await userWith({ achats: 'read' }, 'lecteur');
  assert.equal((await call('POST', `/purchases/${id}/order`, { document_id: or }, reader)).status, 403);
  assert.equal((await call('POST', `/purchases/${id}/assign`, { reason: 'Outillage' }, reader)).status, 403);
  assert.equal((await purchase(id)).status, 'draft');
  // l'acheteur n'a pas accès à l'atelier : il trouve quand même l'OR à rattacher, et valide
  const buyer = await userWith({ achats: 'user' }, 'acheteur');
  assert.equal((await call('GET', '/documents/' + or, undefined, buyer)).status, 403);
  assert.ok((await call('GET', '/purchases/orders?q=XY', undefined, buyer)).data.some((o) => o.id === or));
  assert.equal((await call('POST', `/purchases/${id}/order`, { document_id: or }, buyer)).status, 200);
  // l'atelier voit les commandes de son OR, sans montant ni lien vers l'achat
  const workshop = await userWith({ atelier: 'user' }, 'atelier');
  const seen = (await call('GET', `/documents/${or}/purchases`, undefined, workshop)).data;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].supplier_name, 'Pièces Auto Lux');
  assert.equal(seen[0].status, 'ordered');
  assert.ok(!('total' in seen[0]) && !('id' in seen[0]), JSON.stringify(seen[0]));
  assert.equal((await call('GET', '/purchases/orders', undefined, workshop)).status, 403);
  // quelqu'un qui ne peut pas lire l'OR ne voit pas ses commandes par ce chemin
  const sales = await userWith({ ventes: 'user' }, 'vendeur');
  assert.equal((await call('GET', `/documents/${or}/purchases`, undefined, sales)).status, 403);
});

test('OR supprimé : ses commandes ne pointent plus vers lui, mais gardent la trace', async () => {
  const or = await doc('order');
  const number = (await A('GET', '/documents/' + or)).data.number;
  const id = await buy();
  assert.equal((await A('POST', `/purchases/${id}/order`, { document_id: or })).status, 200);
  assert.equal((await A('DELETE', '/documents/' + or)).status, 200);
  const p = await purchase(id);
  assert.equal(p.document_id, null);
  assert.equal(p.order_number, null);
  assert.ok(p.reason.includes(number), p.reason);
  assert.equal(p.status, 'ordered');
});

test('réassort automatique du stock : la raison est déjà écrite', async () => {
  const product = (await A('POST', '/products', { ref: 'HF-1', name: 'Filtre à huile', supplier_id: supplier, qty_min: 2, purchase_price: 6, sale_price: 14, tax_rate: 17 })).data.id;
  assert.ok(product);
  const r = await A('POST', '/stock/reorder');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.created.length, 1);
  const p = await purchase(r.data.created[0]);
  assert.match(p.reason, /Réassort du stock/);
  assert.equal(p.document_id, null);
  // elle se valide sans autre question
  assert.equal((await A('POST', `/purchases/${p.id}/order`, {})).status, 200);
  assert.equal((await purchase(p.id)).status, 'ordered');
});
