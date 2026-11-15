// Gardiennage des roues : fiche été / hiver d'un véhicule, photos de chaque roue, rappel « devis à faire » quand des
// pneus sont à remplacer, saisie par le mécanicien sur la tablette (depuis l'OR), droits.
// Le test démarre un vrai serveur sur une base vide et passe par l'API, comme le navigateur et la tablette.
process.env.TZ ||= 'Europe/Luxembourg';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 5700 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-wheels-'));
let server, admin, customer, car;

async function call(method, url, body, tok, headers = {}) {
  const raw = Buffer.isBuffer(body);
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(raw ? { 'Content-Type': 'image/jpeg' } : { 'Content-Type': 'application/json' }), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(buf.toString()); } catch { /* pas de JSON */ }
  return { status: res.status, data, buf, headers: res.headers, text: buf.toString() };
}
const A = (method, url, body) => call(method, url, body, admin);
const day = (n = 0) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const jpeg = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF ' + tag)]);
const png = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
const quotes = async (tok = admin, status = 'planned') => (await call('GET', `/activities?status=${status}`, undefined, tok)).data.filter((a) => /Devis pneus/.test(a.summary));
async function userWith(perms, name) {
  const email = `${name}@t.lu`;
  await A('POST', '/users', { name, email, role: 'office', password: 'secret123', permissions: perms });
  return (await call('POST', '/auth/login', { email, password: 'secret123' })).data.token;
}
async function mechanic(name) {
  const id = (await A('POST', '/users', { name, role: 'mechanic', pin: '4321' })).data.id;
  const tok = (await call('POST', '/kiosk/login', { user_id: id, pin: '4321' })).data.token;
  assert.ok(tok, 'session tablette');
  return { id, tok };
}
const order = async (vehicle_id) => (await A('POST', '/documents', { type: 'order', customer_id: customer, vehicle_id, lines: [{ kind: 'labor', description: 'Changement de roues', quantity: 0.5, unit_price: 80, tax_rate: 17 }] })).data.id;

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
  car = (await A('POST', '/vehicles', { customer_id: customer, plate: 'ab 1234', make: 'Volkswagen', model: 'Golf', tyre_size: '205/55 R16' })).data.id;
});
after(() => { server?.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('fiche été / hiver : vide au départ, enregistrée champ par champ, contrôles de saisie', async () => {
  let w = (await A('GET', `/wheels/vehicle/${car}`)).data;
  assert.equal(w.vehicle.plate, 'AB 1234');
  assert.equal(w.summer.id, null);
  assert.deepEqual(w.winter.photos, {});

  w = (await A('PUT', `/wheels/vehicle/${car}/winter`, { brand: '  Michelin   Alpin 6 ', size: '205/55 R16 91H', stored_at: day(), location: 'Rack B3', notes: 'Jantes alu' })).data;
  assert.equal(w.winter.brand, 'Michelin Alpin 6');
  assert.equal(w.winter.stored_at, day());
  assert.equal(w.winter.location, 'Rack B3');
  assert.equal(w.winter.replace_front, 0);
  assert.equal(w.winter.checked_by_name, 'Gérant');
  assert.equal(w.summer.id, null, 'le jeu été n\'est pas touché');
  // seul le champ envoyé change
  w = (await A('PUT', `/wheels/vehicle/${car}/winter`, { location: 'Rack C1' })).data;
  assert.equal(w.winter.location, 'Rack C1');
  assert.equal(w.winter.brand, 'Michelin Alpin 6');
  // on peut vider la date (roues remontées sur le véhicule)
  w = (await A('PUT', `/wheels/vehicle/${car}/winter`, { stored_at: null })).data;
  assert.equal(w.winter.stored_at, null);

  assert.equal((await A('PUT', `/wheels/vehicle/${car}/automne`, { brand: 'x' })).status, 400);
  assert.equal((await A('PUT', `/wheels/vehicle/${car}/winter`, { stored_at: '31/12/2026' })).status, 400);
  assert.equal((await A('PUT', `/wheels/vehicle/${car}/winter`, { brand: { $ne: 1 } })).status, 400);
  assert.equal((await A('PUT', '/wheels/vehicle/99999/winter', { brand: 'x' })).status, 404);
  assert.equal((await A('GET', '/wheels/vehicle/99999')).status, 404);
});

test('pneus à remplacer : un rappel « devis à faire » pour le gérant, un seul, qui suit les corrections', async () => {
  assert.equal((await quotes()).length, 0);
  await A('PUT', `/wheels/vehicle/${car}/winter`, { replace_front: true, stored_at: day() });
  let q = await quotes();
  assert.equal(q.length, 1);
  assert.match(q[0].summary, /Devis pneus à faire : AB 1234 Volkswagen Golf — pneus hiver avant à remplacer/);
  assert.equal(q[0].due_date, day());
  assert.equal(q[0].model, 'vehicle');
  assert.equal(q[0].record_id, car);
  assert.match(q[0].note, /Marc Weber/);
  assert.match(q[0].note, /Michelin Alpin 6/);
  assert.match(q[0].note, /205\/55 R16 91H/);
  const me = (await A('GET', '/me')).data.id;
  assert.equal(q[0].user_id, me, 'rappel pour le gérant');
  let w = (await A('GET', `/wheels/vehicle/${car}`)).data;
  assert.equal(w.winter.quote.status, 'planned');

  // enregistrer de nouveau, ou préciser : toujours un seul rappel, mis à jour
  await A('PUT', `/wheels/vehicle/${car}/winter`, { notes: 'Usure irrégulière' });
  await A('PUT', `/wheels/vehicle/${car}/winter`, { replace_rear: true });
  q = await quotes();
  assert.equal(q.length, 1);
  assert.match(q[0].summary, /pneus hiver avant et arrière à remplacer/);
  assert.match(q[0].note, /Usure irrégulière/);

  // le gérant a fait le devis : rien n'est recréé tant que le constat ne change pas
  await A('POST', `/activities/${q[0].id}/done`, {});
  await A('PUT', `/wheels/vehicle/${car}/winter`, { location: 'Rack D2' });
  assert.equal((await quotes()).length, 0);
  assert.equal((await A('GET', `/wheels/vehicle/${car}`)).data.winter.quote.status, 'done');
  // … une nouvelle mise en gardiennage avec des pneus toujours à remplacer relance un rappel
  await A('PUT', `/wheels/vehicle/${car}/winter`, { stored_at: day(1) });
  assert.equal((await quotes()).length, 1);

  // plus rien à remplacer : le rappel en attente est annulé
  await A('PUT', `/wheels/vehicle/${car}/winter`, { replace_front: false, replace_rear: false });
  assert.equal((await quotes()).length, 0);
  assert.equal((await A('GET', `/wheels/vehicle/${car}`)).data.winter.quote, null);
  // le jeu été a son propre rappel
  await A('PUT', `/wheels/vehicle/${car}/summer`, { brand: 'Continental', replace_rear: true });
  q = await quotes();
  assert.equal(q.length, 1);
  assert.match(q[0].summary, /pneus été arrière à remplacer/);
  // l'historique du véhicule garde la trace des constats
  const hist = (await A('GET', `/chatter/vehicle/${car}`)).text;
  assert.match(hist, /Roues hiver : pneus avant à remplacer/);
  assert.match(hist, /Roues été : pneus arrière à remplacer/);
});

test('photos : une par roue, la nouvelle remplace l\'ancienne, seules de vraies photos sont acceptées', async () => {
  let w = (await A('POST', `/wheels/vehicle/${car}/winter/photo/fl`, jpeg('avant gauche'))).data;
  const first = w.winter.photos.fl.id;
  assert.ok(first);
  let img = await A('GET', `/attachment/${first}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.ok(img.buf.equals(jpeg('avant gauche')));

  w = (await A('POST', `/wheels/vehicle/${car}/winter/photo/fl`, png('avant gauche bis'))).data;
  assert.notEqual(w.winter.photos.fl.id, first);
  assert.equal((await A('GET', `/attachment/${first}`)).status, 404, 'l\'ancienne photo est partie');
  assert.equal((await A('GET', `/attachment/${w.winter.photos.fl.id}`)).headers.get('content-type'), 'image/png');
  for (const p of ['fr', 'rl', 'rr']) await A('POST', `/wheels/vehicle/${car}/winter/photo/${p}`, jpeg(p));
  w = (await A('GET', `/wheels/vehicle/${car}`)).data;
  assert.deepEqual(Object.keys(w.winter.photos).sort(), ['fl', 'fr', 'rl', 'rr']);
  assert.deepEqual(w.summer.photos, {});

  // une photo sur un jeu jamais rempli crée sa fiche
  const other = (await A('POST', '/vehicles', { customer_id: customer, plate: 'CD 5678', make: 'Audi', model: 'A3' })).data.id;
  w = (await A('POST', `/wheels/vehicle/${other}/summer/photo/rr`, jpeg('audi'))).data;
  assert.ok(w.summer.id && w.summer.photos.rr);

  // refus : faux fichier image, fichier vide, roue ou saison inconnue
  assert.equal((await A('POST', `/wheels/vehicle/${car}/winter/photo/fr`, Buffer.from('<html><script>alert(1)</script>'))).status, 400);
  assert.equal((await A('POST', `/wheels/vehicle/${car}/winter/photo/fr`, Buffer.alloc(0))).status, 400);
  assert.equal((await A('POST', `/wheels/vehicle/${car}/winter/photo/milieu`, jpeg('x'))).status, 400);
  assert.equal((await A('POST', `/wheels/vehicle/${car}/printemps/photo/fl`, jpeg('x'))).status, 400);

  w = (await A('DELETE', `/wheels/vehicle/${car}/winter/photo/rr`)).data;
  assert.deepEqual(Object.keys(w.winter.photos).sort(), ['fl', 'fr', 'rl']);
});

test('tablette de l\'atelier : le mécanicien remplit la fiche depuis l\'OR, et seulement pour le véhicule de cet OR', async () => {
  const paulo = await mechanic('Paulo');
  const or = await order(car);
  let r = await call('GET', `/kiosk/orders/${or}/wheels`, undefined, paulo.tok);
  assert.equal(r.status, 200);
  assert.equal(r.data.vehicle.plate, 'AB 1234');
  assert.equal(r.data.vehicle.tyre_size, '205/55 R16');
  assert.ok(!('customer_name' in r.data.vehicle) && !('customer_id' in r.data.vehicle));
  assert.equal(r.data.winter.brand, 'Michelin Alpin 6');

  // constat du mécanicien : pneus avant à remplacer → rappel pour le gérant, signé du mécanicien
  const before = (await quotes()).length;
  r = await call('POST', `/kiosk/orders/${or}/wheels/winter`, { brand: 'Michelin Alpin 6', size: '205/55 R16 91H', replace_front: true, replace_rear: false, stored_at: day(), location: 'Rack A1' }, paulo.tok);
  assert.equal(r.status, 200);
  assert.equal(r.data.winter.replace_front, 1);
  assert.equal(r.data.winter.checked_by_name, 'Paulo');
  const q = (await quotes()).filter((a) => /hiver avant à remplacer/.test(a.summary));
  assert.equal((await quotes()).length, before + 1);
  assert.equal(q.length, 1);
  assert.match(q[0].note, /Constat de Paulo/);
  assert.equal(q[0].user_id, (await A('GET', '/me')).data.id);

  // photos depuis la tablette, relues depuis la tablette
  r = await call('POST', `/kiosk/orders/${or}/wheels/winter/photo/rr`, jpeg('tablette'), paulo.tok);
  assert.equal(r.status, 200);
  const att = r.data.winter.photos.rr.id;
  const img = await call('GET', `/kiosk/orders/${or}/wheels/photo/${att}`, undefined, paulo.tok);
  assert.equal(img.status, 200);
  assert.ok(img.buf.equals(jpeg('tablette')));
  assert.equal((await call('POST', `/kiosk/orders/${or}/wheels/winter/photo/rr`, Buffer.from('pas une image'), paulo.tok)).status, 400);
  assert.equal((await call('DELETE', `/kiosk/orders/${or}/wheels/winter/photo/rr`, undefined, paulo.tok)).data.winter.photos.rr, undefined);

  // la session de la tablette n'ouvre ni les routes du bureau, ni les autres pièces jointes
  assert.equal((await call('GET', `/wheels/vehicle/${car}`, undefined, paulo.tok)).status, 403);
  assert.equal((await call('GET', '/wheels', undefined, paulo.tok)).status, 403);
  const fl = (await A('GET', `/wheels/vehicle/${car}`)).data.winter.photos.fl.id;
  assert.equal((await call('GET', `/attachment/${fl}`, undefined, paulo.tok)).status, 403);
  // une photo d'un autre véhicule n'est pas servie par cet OR
  const other = (await A('GET', '/vehicles?q=CD5678')).data[0].id;
  const foreign = (await A('GET', `/wheels/vehicle/${other}`)).data.summer.photos.rr.id;
  assert.equal((await call('GET', `/kiosk/orders/${or}/wheels/photo/${foreign}`, undefined, paulo.tok)).status, 404);
  // sans session, OR sans véhicule, OR clôturé ou inconnu : refusé
  assert.equal((await call('GET', `/kiosk/orders/${or}/wheels`)).status, 401);
  const bare = (await A('POST', '/documents', { type: 'order', customer_id: customer, lines: [] })).data.id;
  assert.equal((await call('GET', `/kiosk/orders/${bare}/wheels`, undefined, paulo.tok)).status, 400);
  assert.equal((await call('GET', '/kiosk/orders/99999/wheels', undefined, paulo.tok)).status, 404);
  const quote = (await A('POST', '/documents', { type: 'quote', customer_id: customer, vehicle_id: car, lines: [] })).data.id;
  assert.equal((await call('GET', `/kiosk/orders/${quote}/wheels`, undefined, paulo.tok)).status, 404, 'un devis n\'est pas un OR');
  await A('POST', `/documents/${or}/status`, { status: 'cancelled' });
  assert.equal((await call('POST', `/kiosk/orders/${or}/wheels/winter`, { brand: 'x' }, paulo.tok)).status, 404);
});

test('droits : Parc automobile en lecture pour consulter, utilisateur pour remplir ; rien sans ce droit', async () => {
  const none = await userWith({ banque: 'user' }, 'banque');
  const read = await userWith({ vehicules: 'read' }, 'lecture');
  const user = await userWith({ vehicules: 'user' }, 'parc');
  const fl = (await A('GET', `/wheels/vehicle/${car}`)).data.winter.photos.fl.id;

  for (const [m, u, b] of [['GET', `/wheels/vehicle/${car}`], ['GET', '/wheels'], ['PUT', `/wheels/vehicle/${car}/winter`, { brand: 'x' }], ['GET', `/attachment/${fl}`]]) assert.equal((await call(m, u, b, none)).status, 403, `${m} ${u}`);
  assert.equal((await call('POST', `/wheels/vehicle/${car}/winter/photo/fl`, jpeg('x'), none)).status, 403);
  assert.ok(!(await call('GET', '/activities', undefined, none)).text.includes('Devis pneus'), 'le rappel n\'est pas montré sans le droit sur le véhicule');

  assert.equal((await call('GET', `/wheels/vehicle/${car}`, undefined, read)).status, 200);
  assert.equal((await call('GET', `/attachment/${fl}`, undefined, read)).status, 200);
  assert.equal((await call('PUT', `/wheels/vehicle/${car}/winter`, { brand: 'x' }, read)).status, 403);
  assert.equal((await call('POST', `/wheels/vehicle/${car}/winter/photo/fl`, jpeg('x'), read)).status, 403);
  assert.equal((await call('DELETE', `/wheels/vehicle/${car}/winter/photo/fl`, undefined, read)).status, 403);

  assert.equal((await call('PUT', `/wheels/vehicle/${car}/winter`, { location: 'Rack A2' }, user)).data.winter.location, 'Rack A2');
  assert.equal((await call('POST', `/wheels/vehicle/${car}/winter/photo/rr`, jpeg('bureau'), user)).status, 200);
  assert.equal((await call('DELETE', `/wheels/vehicle/${car}/winter/photo/rr`, undefined, user)).status, 200, 'retirer une photo : niveau utilisateur');
});

test('vue d\'ensemble et suppression du véhicule', async () => {
  let list = (await A('GET', '/wheels')).data;
  const mine = list.filter((r) => r.vehicle_id === car);
  assert.deepEqual(mine.map((r) => r.season).sort(), ['summer', 'winter']);
  assert.equal(list[0].replace_front || list[0].replace_rear, 1, 'les pneus à remplacer viennent d\'abord');
  const winter = mine.find((r) => r.season === 'winter');
  assert.equal(winter.plate, 'AB 1234');
  assert.equal(winter.customer_name, 'Marc Weber');
  assert.equal(winter.photo_count, 3);
  assert.ok((await A('GET', '/wheels?filter=replace')).data.every((r) => r.replace_front || r.replace_rear));
  assert.ok((await A('GET', '/wheels?filter=stored')).data.every((r) => r.stored_at));

  // véhicule supprimé : fiches, photos et rappels partent avec lui
  const tmp = (await A('POST', '/vehicles', { customer_id: customer, plate: 'ZZ 9999', make: 'Fiat', model: 'Panda' })).data.id;
  const w = (await A('POST', `/wheels/vehicle/${tmp}/summer/photo/fl`, jpeg('panda'))).data;
  await A('PUT', `/wheels/vehicle/${tmp}/summer`, { replace_front: true });
  assert.ok((await quotes()).some((a) => /ZZ 9999/.test(a.summary)));
  assert.equal((await A('DELETE', `/vehicles/${tmp}`)).status, 200);
  assert.equal((await A('GET', `/attachment/${w.summer.photos.fl.id}`)).status, 404);
  assert.ok(!(await A('GET', '/wheels')).data.some((r) => r.vehicle_id === tmp));
  assert.ok(!(await quotes()).some((a) => /ZZ 9999/.test(a.summary)));
  // un nouveau véhicule ne récupère rien de l'ancien
  const next = (await A('POST', '/vehicles', { customer_id: customer, plate: 'YY 1111' })).data.id;
  const fresh = (await A('GET', `/wheels/vehicle/${next}`)).data;
  assert.equal(fresh.summer.id, null);
  assert.deepEqual(fresh.summer.photos, {});
});
