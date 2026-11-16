// Impression des documents : le logiciel note quand, par qui et combien de fois un OR a été imprimé, pour qu'on ne
// sorte pas deux fois la même feuille d'atelier. Le test démarre un vrai serveur sur une base vide et passe par l'API.
process.env.TZ ||= 'Europe/Luxembourg';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = 5900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-print-'));
let server, admin, customer;

async function call(method, url, body, tok) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* pas de JSON */ }
  return { status: res.status, data, text };
}
const A = (method, url, body) => call(method, url, body, admin);
/** Écrit directement dans la base du serveur de test (ici : reculer l'heure de la dernière impression). */
function sql(query, ...params) {
  const d = new DatabaseSync(path.join(dataDir, 'garage.db'));
  try { d.exec('PRAGMA busy_timeout=3000'); return d.prepare(query).run(...params); } finally { d.close(); }
}
const earlier = (id) => sql("UPDATE documents SET printed_at='2026-01-05T08:00:00' WHERE id=?", id);
const order = async (type = 'order') => (await A('POST', '/documents', { type, customer_id: customer, lines: [{ kind: 'labor', description: 'Vidange', quantity: 1, unit_price: 80, tax_rate: 17 }] })).data.id;
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
});
after(() => { server?.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('un OR jamais imprimé, puis imprimé : date, personne, nombre de fois, visible dans la fiche et dans la liste', async () => {
  const id = await order();
  let d = (await A('GET', `/documents/${id}`)).data;
  assert.equal(d.print_count, 0);
  assert.equal(d.printed_at, null);
  const before = d.updated_at;

  let r = await A('POST', `/documents/${id}/printed`);
  assert.equal(r.status, 200);
  assert.equal(r.data.print_count, 1);
  assert.equal(r.data.printed_by_name, 'Gérant');
  assert.match(r.data.printed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

  d = (await A('GET', `/documents/${id}`)).data;
  assert.equal(d.print_count, 1);
  assert.equal(d.printed_by_name, 'Gérant');
  assert.equal(d.updated_at, before, 'noter l\'impression ne « modifie » pas le document (une saisie en cours ailleurs n\'est pas dérangée)');
  const row = (await A('GET', '/documents?type=order')).data.find((x) => x.id === id);
  assert.equal(row.print_count, 1);
  assert.ok(row.printed_at);
  assert.match((await A('GET', `/chatter/document/${id}`)).text, /Imprimé/);

  // le navigateur signale l'impression (Ctrl+P) juste après le bouton : c'est la même, comptée une seule fois
  assert.equal((await A('POST', `/documents/${id}/printed`, { auto: true })).data.print_count, 1);
  // une réimpression demandée par le bouton est toujours comptée, même dans la foulée, et l'historique le dit
  r = await A('POST', `/documents/${id}/printed`, { seen: 1 });
  assert.equal(r.data.print_count, 2);
  assert.match((await A('GET', `/chatter/document/${id}`)).text, /Imprimé de nouveau \(2e fois\)/);
  // plus tard, une impression par le menu du navigateur est comptée
  earlier(id);
  assert.equal((await A('POST', `/documents/${id}/printed`, { auto: true })).data.print_count, 3);
  // quelqu'un d'autre imprime juste après : compté aussi (c'est justement le doublon qu'on veut voir)
  const colleague = await userWith({ atelier: 'user' }, 'accueil');
  r = await call('POST', `/documents/${id}/printed`, {}, colleague);
  assert.equal(r.data.print_count, 4);
  assert.equal(r.data.printed_by_name, 'accueil');

  // deux personnes au même moment : la seconde avait vu « 4 impressions » à l'écran, le serveur en est à 5 → refus,
  // rien n'est noté, l'écran relira et reposera la question
  assert.equal((await A('POST', `/documents/${id}/printed`, { seen: 4 })).data.print_count, 5);
  r = await call('POST', `/documents/${id}/printed`, { seen: 4 }, colleague);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /vient d’être imprimé par quelqu’un d’autre/);
  assert.equal((await A('GET', `/documents/${id}`)).data.print_count, 5);
  assert.equal((await call('POST', `/documents/${id}/printed`, { seen: 5 }, colleague)).data.print_count, 6);
  // même chose sur un OR jamais imprimé : le second est arrêté
  const fresh = await order();
  assert.equal((await A('POST', `/documents/${fresh}/printed`, { seen: 0 })).data.print_count, 1);
  assert.equal((await call('POST', `/documents/${fresh}/printed`, { seen: 0 }, colleague)).status, 409);
});

test('la marque ne se modifie pas par l\'enregistrement du document ; on peut la retirer si la feuille n\'est pas sortie', async () => {
  const id = await order();
  await A('POST', `/documents/${id}/printed`);
  const d = (await A('GET', `/documents/${id}`)).data;
  // l'écran renvoie tout le document à l'enregistrement : les champs d'impression n'en font pas partie
  assert.equal((await A('PUT', `/documents/${id}`, { ...d, print_count: 99, printed_at: null, printed_by: 12345, diagnosis: 'Vu' })).status, 200);
  let x = (await A('GET', `/documents/${id}`)).data;
  assert.equal(x.print_count, 1);
  assert.equal(x.printed_by_name, 'Gérant');
  assert.equal(x.diagnosis, 'Vu');

  const r = await A('DELETE', `/documents/${id}/printed`);
  assert.equal(r.status, 200);
  assert.equal(r.data.print_count, 0);
  assert.equal(r.data.printed_at, null);
  x = (await A('GET', `/documents/${id}`)).data;
  assert.equal(x.print_count, 0);
  assert.equal(x.printed_by_name, null);
  assert.match((await A('GET', `/chatter/document/${id}`)).text, /Marque « imprimé » retirée/);
  // de nouveau imprimé ensuite : on repart de 1
  assert.equal((await A('POST', `/documents/${id}/printed`)).data.print_count, 1);
  // la facture créée à partir de l'OR n'hérite pas de la marque
  const inv = (await A('POST', `/documents/${id}/convert`, { type: 'invoice' })).data.id;
  assert.equal((await A('GET', `/documents/${inv}`)).data.print_count, 0);
  assert.equal((await A('POST', '/documents/99999/printed')).status, 404);
  assert.equal((await A('DELETE', '/documents/99999/printed')).status, 404);
});

test('droits : noter l\'impression demande de pouvoir lire le document ; retirer la marque, le niveau utilisateur', async () => {
  const or = await order();
  const quote = await order('quote');
  const reader = await userWith({ atelier: 'read' }, 'lecture');
  const worker = await userWith({ atelier: 'user' }, 'atelier');
  const seller = await userWith({ ventes: 'user' }, 'ventes');

  // lecture seule sur l'Atelier : il peut imprimer l'OR (c'est noté), pas retirer la marque
  assert.equal((await call('POST', `/documents/${or}/printed`, undefined, reader)).data.print_count, 1);
  assert.equal((await call('DELETE', `/documents/${or}/printed`, undefined, reader)).status, 403);
  assert.equal((await call('DELETE', `/documents/${or}/printed`, undefined, worker)).data.print_count, 0);
  // un devis relève des Ventes : l'atelier seul n'y touche pas, et inversement
  assert.equal((await call('POST', `/documents/${quote}/printed`, undefined, worker)).status, 403);
  assert.equal((await call('POST', `/documents/${or}/printed`, undefined, seller)).status, 403);
  assert.equal((await call('POST', `/documents/${quote}/printed`, undefined, seller)).data.print_count, 1);
  assert.equal((await call('POST', `/documents/${or}/printed`)).status, 401);
  // la liste ne montre la marque qu'à ceux qui voient le document
  assert.equal((await call('GET', '/documents?type=order', undefined, seller)).status, 403);
  assert.ok(!(await call('GET', '/documents', undefined, seller)).data.some((x) => x.id === or));
});

test('facture envoyée par mail : la fiche et la liste le disent (quand, à qui, par qui, combien de fois)', async () => {
  await A('PUT', '/mail/config', { from_email: 'info@garage.lu', from_name: 'Garage Test' });
  const inv = await order('invoice');
  let d = (await A('GET', `/documents/${inv}`)).data;
  assert.equal(d.mail_count, 0);
  assert.equal(d.mailed_at, null);
  // un brouillon ne s'envoie pas au client
  assert.equal((await A('POST', '/mail/send', { model: 'document', record_id: inv, to: 'marc@client.lu', subject: 'Votre facture', intro: 'Bonjour', include_document: true })).status, 400);
  assert.equal((await A('POST', `/documents/${inv}/post`)).status, 200);

  // un message sans la facture (simple relance) ne compte pas comme « facture envoyée »
  assert.equal((await A('POST', '/mail/send', { model: 'document', record_id: inv, to: 'marc@client.lu', subject: 'Petit mot', intro: 'Bonjour', include_document: false })).status, 200);
  assert.equal((await A('GET', `/documents/${inv}`)).data.mail_count, 0);

  const r = await A('POST', '/mail/send', { model: 'document', record_id: inv, to: 'marc@client.lu', subject: 'Votre facture', intro: 'Bonjour', include_document: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'sent');
  d = (await A('GET', `/documents/${inv}`)).data;
  assert.equal(d.mail_count, 1);
  assert.equal(d.mailed_to, 'marc@client.lu');
  assert.equal(d.mailed_by_name, 'Gérant');
  assert.match(d.mailed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  const row = (await A('GET', '/documents?type=invoice')).data.find((x) => x.id === inv);
  assert.equal(row.mailed_at, d.mailed_at);
  assert.equal(row.print_count, 0);

  // second envoi à une autre adresse : c'est le dernier qui est affiché, et le compte monte
  await A('POST', '/mail/send', { model: 'document', record_id: inv, to: 'compta@client.lu', subject: 'Votre facture (copie)', intro: 'Bonjour', include_document: true });
  d = (await A('GET', `/documents/${inv}`)).data;
  assert.equal(d.mail_count, 2);
  assert.equal(d.mailed_to, 'compta@client.lu');
  // envoi programmé : annoncé, pas encore compté
  const t = new Date(Date.now() + 3 * 86400000);
  const later = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}T08:00`;
  assert.equal((await A('POST', '/mail/send', { model: 'document', record_id: inv, to: 'marc@client.lu', subject: 'Rappel', intro: 'Bonjour', include_document: true, scheduled_at: later })).data.status, 'scheduled');
  d = (await A('GET', `/documents/${inv}`)).data;
  assert.equal(d.mail_count, 2);
  assert.ok(d.mail_scheduled_at.startsWith(later));
  // l'enregistrement du document ne touche pas à ces informations, et une autre facture n'en hérite pas
  const other = await order('invoice');
  assert.equal((await A('GET', `/documents/${other}`)).data.mail_count, 0);
  assert.equal((await A('GET', '/documents?type=invoice')).data.find((x) => x.id === other).mailed_at, null);
});


test('un brouillon imprimé pour relecture, puis validé : la facture numérotée repart « jamais imprimée »', async () => {
  const inv = await order('invoice');
  // le brouillon est imprimé (épreuve) : c'est noté sur le brouillon…
  assert.equal((await A('POST', `/documents/${inv}/printed`)).data.print_count, 1);
  assert.equal((await A('GET', `/documents/${inv}`)).data.print_count, 1);
  // …mais la facture validée n'a encore été ni imprimée ni envoyée : elle doit rester dans « à remettre au client »
  const posted = await A('POST', `/documents/${inv}/post`);
  assert.equal(posted.status, 200);
  const d = (await A('GET', `/documents/${inv}`)).data;
  assert.equal(d.status, 'posted');
  assert.equal(d.print_count, 0);
  assert.equal(d.printed_at, null);
  assert.equal(d.printed_by_name, null);
  const row = (await A('GET', '/documents?type=invoice')).data.find((x) => x.id === inv);
  assert.equal(row.print_count, 0);
  assert.equal(row.printed_at, null);
  // une fois validée, l'impression compte de nouveau normalement
  assert.equal((await A('POST', `/documents/${inv}/printed`)).data.print_count, 1);
});

test('facture : la marque, le modèle, le n° de châssis et le kilométrage du véhicule suivent le document (fiche et e-mail)', async () => {
  const car = (await A('POST', '/vehicles', { customer_id: customer, plate: 'KM 2026', make: 'Peugeot', model: '308 SW', vin: 'VF3LBHNZ6KS123456' })).data.id;
  const or = (await A('POST', '/documents', { type: 'order', customer_id: customer, vehicle_id: car, mileage: 125300, lines: [{ kind: 'labor', description: 'Vidange', quantity: 1, unit_price: 80, tax_rate: 17 }] })).data.id;
  // la facture tirée de l'OR reprend son kilométrage
  const inv = (await A('POST', `/documents/${or}/convert`, { type: 'invoice' })).data.id;
  const d = (await A('GET', `/documents/${inv}`)).data;
  assert.equal(d.type, 'invoice');
  assert.equal(d.make, 'Peugeot');
  assert.equal(d.model, '308 SW');
  assert.equal(d.vin, 'VF3LBHNZ6KS123456');
  assert.equal(d.mileage, 125300);
  // et le message envoyé au client les mentionne
  const html = (await A('POST', '/mail/preview', { model: 'document', record_id: inv, intro: 'Bonjour', include_document: true })).data.html;
  assert.match(html, /KM 2026 Peugeot 308 SW/);
  assert.match(html, /N° de châssis : VF3LBHNZ6KS123456/);
  assert.match(html, /Kilométrage : 125[\s  .]300 km/);
});
