// Personnalisation des fiches (façon « Studio ») : champs, zones de fichiers PDF et boutons ajoutés par le gérant.
// Le test démarre un vrai serveur sur une base vide et passe par l'API, comme le navigateur.
process.env.TZ ||= 'Europe/Luxembourg';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4700 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-studio-'));
let server, admin;

async function call(method, url, body, tok, headers = {}) {
  const raw = Buffer.isBuffer(body);
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(buf.toString('utf8')); } catch { data = buf; }
  return { status: res.status, data, headers: res.headers };
}
const A = (method, url, body, headers) => call(method, url, body, admin, headers);
const field = async (body) => { const r = await A('POST', '/studio/fields', body); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.id; };
const zone = async (model, id, tok = admin) => (await call('GET', `/studio/record/${model}/${id}`, undefined, tok)).data;
const byId = (z, id) => z.fields.find((f) => f.id === id);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const upload = (model, id, fieldId, buf, mime, name, tok = admin) => call('POST', `/studio/files/${model}/${id}/${fieldId}`, buf, tok, { 'Content-Type': mime, 'X-Filename': encodeURIComponent(name) });
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
  const s = await call('POST', '/auth/setup', { name: 'Gérant', email: 'g@t.lu', password: 'secret123', company: 'Garage Test' });
  assert.equal(s.status, 200, out);
  admin = s.data.token;
});
after(() => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('concepteur : réservé à l\'administrateur, éléments contrôlés', async () => {
  const office = await userWith({ contacts: 'manager', atelier: 'manager' }, 'bureau');
  assert.equal((await call('POST', '/studio/fields', { target: 'customer', kind: 'text', label: 'Pirate' }, office)).status, 403);
  assert.equal((await call('GET', '/studio/fields?target=customer', undefined, office)).status, 403);
  assert.equal((await call('GET', '/studio/meta', undefined, office)).status, 200, 'la liste des fiches personnalisables se lit');

  // refus : fiche ou type inconnu, nom vide, liste sans choix, lien dangereux, bouton sans action
  for (const bad of [
    { target: 'nope', kind: 'text', label: 'X' }, { target: 'customer', kind: 'nope', label: 'X' }, { target: 'customer', kind: 'text', label: '   ' },
    { target: 'customer', kind: 'select', label: 'Liste', options: { choices: [] } },
    { target: 'customer', kind: 'button', label: 'Lien', options: { action: 'link', url: 'javascript:alert(1)' } },
    { target: 'customer', kind: 'button', label: 'Lien', options: { action: 'link', url: 'data:text/html,<script>1</script>' } },
    { target: 'customer', kind: 'button', label: 'Rien', options: {} },
    { target: 'customer', kind: 'button', label: 'Mail', options: { action: 'email', subject: '' } },
    { target: 'customer', kind: 'button', label: 'Tampon', options: { action: 'stamp', field_id: 999999 } },
  ]) assert.equal((await A('POST', '/studio/fields', bad)).status, 400, JSON.stringify(bad));

  const txt = await field({ target: 'customer', kind: 'text', label: '  Numéro de sinistre  ', help: 'Donné par l\'assurance' });
  const list = (await A('GET', '/studio/fields?target=customer')).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'Numéro de sinistre');
  // le type et la fiche d'un élément ne changent pas ; le nom et l'aide oui ; masquer sans supprimer
  assert.equal((await A('PUT', `/studio/fields/${txt}`, { target: 'vehicle', kind: 'date', label: 'N° sinistre', active: 0 })).status, 200);
  const after = (await A('GET', '/studio/fields?target=customer')).data[0];
  assert.deepEqual([after.target, after.kind, after.label, after.active], ['customer', 'text', 'N° sinistre', 0]);
  assert.equal((await A('GET', '/studio/fields?target=vehicle')).data.length, 0);
  const cust = (await A('POST', '/customers', { name: 'Client masqué' })).data.id;
  assert.equal((await zone('customer', cust)).fields.length, 0, 'un élément masqué n\'apparaît pas sur les fiches');
  assert.equal((await A('DELETE', `/studio/fields/${txt}`)).status, 200);
  assert.equal((await A('DELETE', `/studio/fields/${txt}`)).status, 404);
});

test('champs : valeurs enregistrées par fiche, contrôlées, selon le type de document', async () => {
  const ids = {
    text: await field({ target: 'order', kind: 'text', label: 'Bon de commande' }),
    area: await field({ target: 'order', kind: 'textarea', label: 'Consignes' }),
    num: await field({ target: 'order', kind: 'number', label: 'Pression pneus', options: { unit: 'bar' } }),
    date: await field({ target: 'order', kind: 'date', label: 'Véhicule lavé le' }),
    box: await field({ target: 'order', kind: 'checkbox', label: 'Véhicule de prêt' }),
    sel: await field({ target: 'order', kind: 'select', label: 'Assurance', options: { choices: 'Foyer\nLalux\n\nFoyer\nBaloise' } }),
    inv: await field({ target: 'invoice', kind: 'text', label: 'Dossier assurance' }),
  };
  const cust = (await A('POST', '/customers', { name: 'Client Studio' })).data.id;
  const or = (await A('POST', '/documents', { type: 'order', customer_id: cust, lines: [] })).data.id;
  const quote = (await A('POST', '/documents', { type: 'quote', customer_id: cust, lines: [] })).data.id;
  const invoice = (await A('POST', '/documents', { type: 'invoice', customer_id: cust, lines: [{ kind: 'labor', description: 'MO', quantity: 1, unit_price: 80, tax_rate: 17 }] })).data.id;

  let z = await zone('document', or);
  assert.equal(z.target, 'order');
  assert.deepEqual(z.fields.map((f) => f.label), ['Bon de commande', 'Consignes', 'Pression pneus', 'Véhicule lavé le', 'Véhicule de prêt', 'Assurance']);
  assert.deepEqual(byId(z, ids.sel).options.choices, ['Foyer', 'Lalux', 'Baloise'], 'choix sans doublon ni ligne vide');
  assert.equal(z.can_write, true);
  assert.equal((await zone('document', quote)).fields.length, 0, 'un champ d\'OR n\'apparaît pas sur un devis');
  assert.deepEqual((await zone('document', invoice)).fields.map((f) => f.label), ['Dossier assurance']);

  const put = (values) => A('PUT', `/studio/record/document/${or}`, { values });
  assert.equal((await put({ [ids.text]: 'BC-2026-17', [ids.area]: 'Ligne 1\nLigne 2', [ids.num]: '2,4', [ids.date]: '2026-11-14', [ids.box]: true, [ids.sel]: 'Lalux' })).status, 200);
  z = await zone('document', or);
  assert.equal(byId(z, ids.text).value, 'BC-2026-17');
  assert.equal(byId(z, ids.area).value, 'Ligne 1\nLigne 2');
  assert.equal(byId(z, ids.num).value, 2.4, 'nombre avec virgule accepté');
  assert.equal(byId(z, ids.date).value, '2026-11-14');
  assert.equal(byId(z, ids.box).value, true);
  assert.equal(byId(z, ids.sel).value, 'Lalux');
  // refus : nombre, date ou choix invalide ; champ d'une autre fiche ; champ inconnu — rien n'est enregistré à moitié
  for (const bad of [{ [ids.num]: 'abc' }, { [ids.date]: '2026-02-31' }, { [ids.sel]: 'Autre' }, { [ids.inv]: 'x' }, { 999999: 'x' }, { [ids.text]: 'ok', [ids.num]: 'abc' }]) {
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(byId(await zone('document', or), ids.text).value, 'BC-2026-17', 'un envoi refusé ne change rien');
  assert.equal((await A('PUT', `/studio/record/document/${or}`, { values: [1, 2] })).status, 400);
  // vider un champ, décocher une case
  await put({ [ids.text]: '', [ids.box]: false, [ids.num]: null });
  z = await zone('document', or);
  assert.equal(byId(z, ids.text).value, null);
  assert.equal(byId(z, ids.box).value, null);
  assert.equal(byId(z, ids.num).value, null);
  // texte long tronqué, retour à la ligne retiré d'une zone d'une ligne
  await put({ [ids.text]: 'a\nb' });
  assert.equal(byId(await zone('document', or), ids.text).value, 'a b');
  // une autre fiche a ses propres valeurs
  const or2 = (await A('POST', '/documents', { type: 'order', customer_id: cust, lines: [] })).data.id;
  assert.equal(byId(await zone('document', or2), ids.sel).value, null);
  // fiche inconnue, type de fiche inconnu
  assert.equal((await A('GET', '/studio/record/document/999999')).status, 404);
  assert.equal((await A('GET', '/studio/record/users/1')).status, 400);
  // document supprimé : ses valeurs disparaissent avec lui
  assert.equal((await A('DELETE', `/documents/${or}`)).status, 200);
  assert.equal((await A('GET', `/studio/record/document/${or}`)).status, 404);
});

test('droits : remplir demande le droit sur la fiche, comme le reste de la fiche', async () => {
  const f = await field({ target: 'vehicle', kind: 'text', label: 'Code radio' });
  const cust = (await A('POST', '/customers', { name: 'Droits' })).data.id;
  const veh = (await A('POST', '/vehicles', { customer_id: cust, plate: 'AB 1234' })).data.id;
  const reader = await userWith({ vehicules: 'read' }, 'lecteur');
  // (travailler dans les Ventes donne la lecture des véhicules : on prend quelqu'un qui n'a que la Banque)
  const none = await userWith({ banque: 'user' }, 'banque');
  const z = await zone('vehicle', veh, reader);
  assert.equal(z.can_write, false);
  assert.equal(z.fields.length, 1);
  assert.equal((await call('PUT', `/studio/record/vehicle/${veh}`, { values: { [f]: 'x' } }, reader)).status, 403);
  assert.equal((await call('GET', `/studio/record/vehicle/${veh}`, undefined, none)).status, 403, 'sans droit sur les véhicules : rien');
  // OR : droit Atelier ; sans ce droit, la zone d'un OR ne se lit pas
  const or = (await A('POST', '/documents', { type: 'order', customer_id: cust, lines: [] })).data.id;
  assert.equal((await call('GET', `/studio/record/document/${or}`, undefined, none)).status, 403);
  const atelier = await userWith({ atelier: 'user' }, 'atelier');
  assert.equal((await zone('document', or, atelier)).can_write, true);
});

test('zones PDF : dépôt, contrôle du fichier, téléchargement, retrait', async () => {
  const pdfZone = await field({ target: 'vehicle', kind: 'file', label: 'Carte grise' });
  const anyZone = await field({ target: 'vehicle', kind: 'file', label: 'Photos et scans', options: { accept: 'any' } });
  const cust = (await A('POST', '/customers', { name: 'Fichiers' })).data.id;
  const veh = (await A('POST', '/vehicles', { customer_id: cust, plate: 'CD 5678' })).data.id;
  const ok = await upload('vehicle', veh, pdfZone, PDF, 'application/pdf', 'carte grise été.pdf');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // refus : faux PDF, image dans une zone « PDF seulement », fichier vide, zone inconnue, zone d'une autre fiche
  assert.equal((await upload('vehicle', veh, pdfZone, Buffer.from('<html>pas un pdf</html>'), 'application/pdf', 'faux.pdf')).status, 400);
  assert.equal((await upload('vehicle', veh, pdfZone, Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg', 'photo.jpg')).status, 400);
  assert.equal((await upload('vehicle', veh, pdfZone, Buffer.alloc(0), 'application/pdf', 'vide.pdf')).status, 400);
  assert.equal((await upload('vehicle', veh, 999999, PDF, 'application/pdf', 'x.pdf')).status, 400);
  assert.equal((await upload('customer', cust, pdfZone, PDF, 'application/pdf', 'x.pdf')).status, 400);
  assert.equal((await upload('vehicle', veh, anyZone, Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml', 'x.svg')).status, 400, 'SVG refusé');
  assert.equal((await upload('vehicle', veh, anyZone, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg', 'photo.jpg')).status, 200);

  let z = await zone('vehicle', veh);
  const files = byId(z, pdfZone).files;
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'carte grise été.pdf');
  assert.equal(byId(z, anyZone).files.length, 1);
  const dl = await A('GET', `/attachment/${files[0].id}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.ok(Buffer.compare(dl.data, PDF) === 0, 'le fichier téléchargé est identique');
  // droits : lecture seule → peut ouvrir, pas déposer ni retirer
  const reader = await userWith({ vehicules: 'read' }, 'lecteur2');
  assert.equal((await call('GET', `/attachment/${files[0].id}`, undefined, reader)).status, 200);
  assert.equal((await upload('vehicle', veh, pdfZone, PDF, 'application/pdf', 'x.pdf', reader)).status, 403);
  assert.equal((await call('DELETE', `/attachment/${files[0].id}`, undefined, reader)).status, 403);
  // retrait
  assert.equal((await A('DELETE', `/attachment/${files[0].id}`)).status, 200);
  assert.equal(byId(await zone('vehicle', veh), pdfZone).files.length, 0);
  // zone supprimée : le fichier reste attaché à la fiche
  assert.equal((await A('DELETE', `/studio/fields/${anyZone}`)).status, 200);
  assert.equal((await A('GET', `/attachments/vehicle/${veh}`)).data.length, 1, 'rien n\'est perdu');
});

test('boutons : lien avec les informations de la fiche, e-mail préparé, champ rempli, activité', async () => {
  const cust = (await A('POST', '/customers', { name: 'Müller & Fils', email: 'muller@t.lu' })).data.id;
  const veh = (await A('POST', '/vehicles', { customer_id: cust, plate: 'AB 12/34', vin: 'WVWZZZ1KZAW000001' })).data.id;
  const link = await field({ target: 'vehicle', kind: 'button', label: 'Catalogue', options: { action: 'link', url: 'https://pieces.exemple.com/recherche?vin={vin}&plaque={plaque}&x={inconnu}' } });
  const mail = await field({ target: 'vehicle', kind: 'button', label: 'Prévenir', options: { action: 'email', subject: 'Votre {plaque} est prête', body: 'Bonjour {client},\nvotre véhicule {plaque} est prêt.' } });
  const washed = await field({ target: 'vehicle', kind: 'date', label: 'Lavé le' });
  const stamp = await field({ target: 'vehicle', kind: 'button', label: 'Marquer lavé', options: { action: 'stamp', field_id: washed } });
  const act = await field({ target: 'vehicle', kind: 'button', label: 'Rappel CT', options: { action: 'activity', summary: 'Rappeler {client} pour le CT de {plaque}', days: 30, activity_type: 'call' } });
  // un bouton « remplir un champ » ne peut viser qu'un champ de la même fiche
  const other = await field({ target: 'customer', kind: 'date', label: 'Autre fiche' });
  assert.equal((await A('POST', '/studio/fields', { target: 'vehicle', kind: 'button', label: 'Mauvais', options: { action: 'stamp', field_id: other } })).status, 400);

  const z = await zone('vehicle', veh);
  assert.equal(byId(z, link).href, 'https://pieces.exemple.com/recherche?vin=WVWZZZ1KZAW000001&plaque=AB%2012%2F34&x={inconnu}', 'valeurs encodées dans l\'adresse');
  assert.deepEqual(byId(z, mail).mail, { subject: 'Votre AB 12/34 est prête', body: 'Bonjour Müller & Fils,\nvotre véhicule AB 12/34 est prêt.' });

  // « Marquer lavé » : la date du jour est inscrite, et l'historique de la fiche le dit
  const r = await A('POST', `/studio/buttons/vehicle/${veh}/${stamp}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const today = new Date().toLocaleDateString('sv-SE');
  assert.equal(byId(r.data.record, washed).value, today);
  const history = (await A('GET', `/chatter/vehicle/${veh}`)).data.messages.map((m) => m.body).join('\n');
  assert.ok(/Marquer lavé/.test(history) && /Lavé le/.test(history), history);
  // « Rappel CT » : une activité pour dans 30 jours, avec les informations de la fiche
  const a = await A('POST', `/studio/buttons/vehicle/${veh}/${act}`, {});
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const acts = (await A('GET', `/chatter/vehicle/${veh}`)).data.activities;
  assert.equal(acts.length, 1);
  assert.equal(acts[0].summary, 'Rappeler Müller & Fils pour le CT de AB 12/34');
  assert.equal(acts[0].type, 'call');
  // un lien ou un e-mail ne s'exécute pas côté serveur ; bouton inconnu ; lecture seule
  assert.equal((await A('POST', `/studio/buttons/vehicle/${veh}/${link}`, {})).status, 400);
  assert.equal((await A('POST', `/studio/buttons/vehicle/${veh}/999999`, {})).status, 400);
  const reader = await userWith({ vehicules: 'read' }, 'lecteur3');
  assert.equal((await call('POST', `/studio/buttons/vehicle/${veh}/${stamp}`, {}, reader)).status, 403);
  // le champ rempli par un bouton ne peut pas être supprimé tant que le bouton existe
  assert.equal((await A('DELETE', `/studio/fields/${washed}`)).status, 400);
  assert.equal((await A('DELETE', `/studio/fields/${stamp}`)).status, 200);
  assert.equal((await A('DELETE', `/studio/fields/${washed}`)).status, 200);
  assert.equal(byId(await zone('vehicle', veh), washed), undefined);

  // ordre d'affichage
  const idsBefore = (await A('GET', '/studio/fields?target=vehicle')).data.map((f) => f.id);
  const reordered = (await A('POST', '/studio/order', { target: 'vehicle', ids: [...idsBefore].reverse() })).data.map((f) => f.id);
  assert.deepEqual(reordered, [...idsBefore].reverse());
  assert.equal((await A('POST', '/studio/order', { target: 'nope', ids: [] })).status, 400);
});
