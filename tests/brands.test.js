// Logos des marques de véhicules : ajout par le garage, affichage public (logiciel et tablette), droits, formats refusés.
process.env.TZ ||= 'Europe/Luxembourg';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4900 + Math.floor(Math.random() * 90);
const ROOT = `http://127.0.0.1:${PORT}`;
const BASE = `${ROOT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-brands-'));
let server, admin;

async function call(method, url, body, tok, headers = {}) {
  const raw = Buffer.isBuffer(body);
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* pas de JSON */ }
  return { status: res.status, data };
}
const A = (method, url, body, headers) => call(method, url, body, admin, headers);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const logo = (name, buf = PNG, tok = admin, mime = 'image/png') => call('POST', `/brands/logo?name=${encodeURIComponent(name)}`, buf, tok, { 'Content-Type': mime });
async function userWith(perms, name) {
  const email = `${name}@t.lu`;
  await A('POST', '/users', { name, email, role: 'office', password: 'secret123', permissions: perms });
  return (await call('POST', '/auth/login', { email, password: 'secret123' })).data.token;
}
const index = async () => (await fetch(`${ROOT}/brands.json`)).json();

before(async () => {
  let out = '';
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', PUBLIC_URL: '' }, stdio: 'pipe' });
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 80 && !/démarré/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  const s = await call('POST', '/auth/setup', { name: 'Gérant', email: 'g@t.lu', password: 'secret123', company: 'Garage Test' });
  assert.equal(s.status, 200, out);
  admin = s.data.token;
});
after(() => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('logo d\'une marque : ajout, affichage sans connexion, variantes d\'écriture, retrait', async () => {
  assert.deepEqual((await index()).logos, {}, 'aucun logo fourni avec le logiciel');
  const cust = (await A('POST', '/customers', { name: 'Client' })).data.id;
  for (const make of ['Volkswagen', 'VW', 'volkswagen ', 'Mercedes-Benz', 'Škoda']) await A('POST', '/vehicles', { customer_id: cust, make, plate: 'X' + make.length });

  // la liste regroupe les écritures d'une même marque
  let list = (await A('GET', '/brands')).data;
  assert.equal(list.odoo, false, 'Odoo non configuré');
  const vw = list.brands.find((b) => b.slug === 'volkswagen');
  assert.equal(vw.vehicles, 3);
  assert.equal(vw.logo, false);
  assert.ok(list.brands.some((b) => b.slug === 'mercedes') && list.brands.some((b) => b.slug === 'skoda'));

  // ajout (sous le nom « VW » : rangé sous Volkswagen)
  const up = await logo('VW');
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.slug, 'volkswagen');
  const idx = await index();
  assert.ok(idx.logos.volkswagen?.v, 'présent dans l\'index public');
  assert.equal(idx.aliases.vw, 'volkswagen');
  // l'image se charge sans être connecté (tablette de l'atelier), sous n'importe quelle écriture
  for (const name of ['volkswagen', 'VW', 'Volkswagen']) {
    const img = await fetch(`${ROOT}/brand/${encodeURIComponent(name)}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  }
  assert.equal((await fetch(`${ROOT}/brand/mercedes`)).status, 404);
  assert.equal((await fetch(`${ROOT}/brand/..%2F..%2Fgarage.db`)).status, 404, 'aucun autre fichier ne peut être demandé');
  list = (await A('GET', '/brands')).data;
  assert.equal(list.brands.find((b) => b.slug === 'volkswagen').source, 'upload');

  // retrait
  assert.equal((await A('DELETE', '/brands/volkswagen')).status, 200);
  assert.equal((await fetch(`${ROOT}/brand/volkswagen`)).status, 404);
  assert.equal((await A('DELETE', '/brands/volkswagen')).status, 404);
  assert.deepEqual((await index()).logos, {});
});

test('fichiers refusés et droits', async () => {
  assert.equal((await logo('')).status, 400, 'nom de marque obligatoire');
  assert.equal((await logo('Audi', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), admin, 'image/svg+xml')).status, 400, 'pas de SVG');
  assert.equal((await logo('Audi', Buffer.from('<html><script>alert(1)</script></html>'), admin, 'image/png')).status, 400, 'le contenu doit être une image');
  assert.equal((await logo('Audi', Buffer.alloc(0))).status, 400);
  assert.equal((await logo('Audi', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]))).status, 400, '1 Mo au plus');
  assert.deepEqual((await index()).logos, {}, 'rien n\'a été enregistré');

  // lecture : droit sur le parc automobile ; ajout et retrait : administrateur de cette application
  const reader = await userWith({ vehicules: 'read' }, 'lecteur');
  const user = await userWith({ vehicules: 'user' }, 'utilisateur');
  const manager = await userWith({ vehicules: 'manager' }, 'responsable');
  const other = await userWith({ banque: 'manager' }, 'banque');
  assert.equal((await call('GET', '/brands', undefined, reader)).status, 200);
  assert.equal((await call('GET', '/brands', undefined, other)).status, 403);
  assert.equal((await logo('Audi', PNG, reader)).status, 403);
  assert.equal((await logo('Audi', PNG, user)).status, 403);
  assert.equal((await logo('Audi', PNG, manager)).status, 200);
  assert.equal((await call('DELETE', '/brands/audi', undefined, user)).status, 403);
  assert.equal((await call('POST', '/brands/import-odoo', {}, manager)).status, 403, 'reprise depuis Odoo : administrateur');
  const noOdoo = await A('POST', '/brands/import-odoo', {});
  assert.equal(noOdoo.status, 400);
  assert.match(noOdoo.data.error, /Odoo/);
  assert.equal((await call('DELETE', '/brands/audi', undefined, manager)).status, 200);
  assert.equal((await call('GET', '/brands')).status, 401);
});
