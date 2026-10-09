// Accès depuis internet (serveur en ligne derrière Caddy, tunnel…) : code d'installation, anti-devinette, PIN du kiosque.
// Le test passe par 127.0.0.1 (proxy de confiance) avec X-Forwarded-For : le serveur voit l'adresse du visiteur.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3800 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-remote-'));
let server, out = '';

async function call(method, url, body, { ip, tok, headers = {} } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(ip ? { 'X-Forwarded-For': ip } : {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

before(async () => {
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', PUBLIC_URL: '' }, stdio: 'pipe' });
  server.stdout.on('data', (d) => { out += d; });
  for (let i = 0; i < 50; i++) {
    if (/Code d'installation/.test(out)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('serveur non démarré');
});
after(() => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const INTERNET = '203.0.113.7';

test("première configuration depuis internet : code d'installation obligatoire", async () => {
  const code = out.match(/Code d'installation[^:]*: ([0-9A-F]{5}-[0-9A-F]{5})/)[1];
  assert.equal((await call('GET', '/auth/status')).data.setupCode, false, 'réseau local : pas de code');
  assert.equal((await call('GET', '/auth/status', undefined, { ip: INTERNET })).data.setupCode, true);
  assert.equal((await call('GET', '/auth/status', undefined, { headers: { 'cf-connecting-ip': INTERNET } })).data.setupCode, true, 'tunnel Cloudflare = internet');
  assert.equal((await call('GET', '/auth/status', undefined, { ip: '192.168.1.20' })).data.setupCode, false, 'Wi-Fi du garage');
  assert.equal((await call('GET', '/auth/status', undefined, { ip: '100.101.102.103' })).data.setupCode, false, 'Tailscale (privé)');

  const admin = { name: 'Gérant', email: 'g@t.lu', password: 'secret123', company: 'Garage' };
  assert.equal((await call('POST', '/auth/setup', admin, { ip: INTERNET })).status, 403, 'sans code');
  assert.equal((await call('POST', '/auth/setup', { ...admin, setup_code: 'AAAAA-BBBBB' }, { ip: INTERNET })).status, 403, 'mauvais code');
  assert.equal((await call('POST', '/auth/setup', { ...admin, password: 'court', setup_code: code }, { ip: INTERNET })).status, 400, '8 caractères minimum');
  const ok = await call('POST', '/auth/setup', { ...admin, setup_code: code.toLowerCase() }, { ip: INTERNET });
  assert.equal(ok.status, 200, 'bon code (minuscules acceptées)');
  assert.equal((await call('POST', '/auth/setup', { ...admin, setup_code: code }, { ip: INTERNET })).status, 403, 'déjà configuré');
});

test('mot de passe : 10 essais par adresse, 20 par compte depuis internet, le garage garde la main', async () => {
  const bad = { email: 'g@t.lu', password: 'mauvais!' };
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/auth/login', bad, { ip: INTERNET })).status, 401);
  assert.equal((await call('POST', '/auth/login', { ...bad, password: 'secret123' }, { ip: INTERNET })).status, 429, 'bloqué même avec le bon mot de passe');
  // Attaque répartie sur plusieurs adresses : le compte est protégé après 20 échecs
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/auth/login', bad, { ip: '198.51.100.9' })).status, 401);
  assert.equal((await call('POST', '/auth/login', { ...bad, password: 'secret123' }, { ip: '198.51.100.10' })).status, 429, 'compte protégé depuis une autre adresse internet');
  assert.equal((await call('POST', '/auth/login', { ...bad, password: 'secret123' })).status, 200, 'au garage (réseau local) : connexion possible');
});

test('kiosque : depuis internet, le code PIN est toujours demandé', async () => {
  const { data: { token } } = await call('POST', '/auth/login', { email: 'g@t.lu', password: 'secret123' });
  const { data: { id: mech } } = await call('POST', '/users', { name: 'Paulo', role: 'mechanic', pin: '4321' }, { tok: token });
  assert.equal((await call('PUT', '/settings', { attendance: { kiosk_pin: false } }, { tok: token })).status, 200);
  assert.equal((await call('GET', '/kiosk/users')).data.pin, false, 'option « PIN » désactivée au garage');
  assert.equal((await call('GET', '/kiosk/users', undefined, { ip: INTERNET })).data.pin, true);
  const lan = await call('POST', '/kiosk/login', { user_id: mech });
  assert.equal(lan.status, 200, 'tablette du garage : sans PIN ' + JSON.stringify(lan.data));
  assert.equal((await call('POST', '/kiosk/login', { user_id: mech }, { ip: INTERNET })).status, 401, 'internet : sans PIN refusé');
  assert.equal((await call('POST', '/kiosk/login', { user_id: mech, pin: '4321' }, { ip: INTERNET })).status, 200, 'internet : avec PIN accepté');
});

test('serveur internet (INTERNET_SERVER=1) : même une adresse privée est traitée comme internet', async () => {
  const port = PORT + 100;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-inet-'));
  const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, ANTHROPIC_API_KEY: '', INTERNET_SERVER: '1' }, stdio: 'ignore' });
  try {
    let st;
    for (let i = 0; i < 50 && !st; i++) st = await fetch(`http://127.0.0.1:${port}/api/auth/status`).then((r) => r.json()).catch(() => new Promise((r) => setTimeout(r, 100)));
    assert.equal(st.setupCode, true, 'proxy Docker (adresse privée) : code demandé');
  } finally { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
