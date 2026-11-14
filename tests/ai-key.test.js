// Clé Claude collée dans Paramètres → Agents IA : essayée avant d'être enregistrée, jamais renvoyée à l'écran,
// active sans redémarrer, réservée à l'administrateur, gardée après un redémarrage, prioritaire sur le fichier .env.
process.env.TZ ||= 'Europe/Luxembourg';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 5300 + Math.floor(Math.random() * 80);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-aikey-'));
const KEY_FILE = path.join(dataDir, 'claude.key');
const KEY = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8'.repeat(5) + '-WXYZ';
const KEY2 = 'sk-ant-api03-' + 'Z9y8X7w6V5u4T3s2'.repeat(5) + '-QRST';
const ENV_KEY = 'sk-ant-api03-' + 'envenvenvenvenv0'.repeat(5) + '-ENV1';
let server, admin;

// Faux service Anthropic : accepte ou refuse selon la file, et garde les en-têtes reçus (quelle clé a servi ?)
const queue = [];
const seen = [];
const claude = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    seen.push({ key: req.headers['x-api-key'] || null, bearer: req.headers.authorization || null, url: req.url, body: b ? JSON.parse(b) : null });
    const next = queue.shift() || {};
    if (next.http) { res.writeHead(next.http, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: next.type || 'api_error', message: next.message || 'Detail' } })); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'test', usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn', content: [{ type: 'text', text: next.text || 'ok' }] }));
  });
});

async function call(method, url, body, tok) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* pas de JSON */ }
  return { status: res.status, data, text };
}
const A = (method, url, body) => call(method, url, body, admin);
const aiOn = async () => (await call('GET', '/auth/status')).data.ai;
async function start(env = {}) {
  let out = '';
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, PUBLIC_URL: '', CLAUDE_MODEL: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${claude.address().port}`, ...env }, stdio: 'pipe' });
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 80 && !/démarré/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  server.out = () => out;
}
const stop = () => new Promise((r) => { server.once('exit', r); server.kill(); });
const login = async () => (await call('POST', '/auth/login', { email: 'g@t.lu', password: 'secret123' })).data.token;

before(async () => {
  await new Promise((r) => claude.listen(0, '127.0.0.1', r));
  await start();
  const s = await call('POST', '/auth/setup', { name: 'Gérant', email: 'g@t.lu', password: 'secret123', company: 'Garage Test' });
  assert.equal(s.status, 200, server.out());
  admin = s.data.token;
});
after(async () => { await stop(); claude.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('sans clé : mode démo, rien d\'enregistré', async () => {
  assert.equal(await aiOn(), false);
  assert.deepEqual((await A('GET', '/ai/key')).data, { source: null, hint: null, model: 'claude-opus-5', env: false });
  assert.equal(fs.existsSync(KEY_FILE), false);
});

test('une clé n\'est enregistrée que si elle marche vraiment', async () => {
  // texte qui n'est pas une clé : refusé sans rien envoyer à Anthropic
  const n = seen.length;
  for (const key of ['', '   ', 'bonjour', 'sk-ant-', 'sk-ant-abc def ghi jkl mno pqr', KEY + '\nautre ligne', 42, { a: 1 }, null]) {
    const r = await A('PUT', '/ai/key', { key });
    assert.equal(r.status, 400, JSON.stringify(key));
  }
  assert.equal((await A('PUT', '/ai/key', {})).status, 400);
  assert.equal(seen.length, n, 'rien n\'est parti');

  // clé refusée par Anthropic
  queue.push({ http: 401, type: 'authentication_error', message: 'invalid x-api-key' });
  const bad = await A('PUT', '/ai/key', { key: KEY });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /refuse cette clé.*n'a pas été enregistrée/);
  // compte sans crédit : le motif donné par Anthropic est montré à l'administrateur
  queue.push({ http: 400, type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' });
  const broke = await A('PUT', '/ai/key', { key: KEY });
  assert.equal(broke.status, 400);
  assert.match(broke.data.error, /credit balance is too low.*crédit.*n'a pas été enregistrée/);
  // modèle indisponible, service en panne, plafond atteint
  queue.push({ http: 404, type: 'not_found_error' });
  assert.match((await A('PUT', '/ai/key', { key: KEY })).data.error, /modèle réglé dans le logiciel \(claude-opus-5\)/);
  queue.push({ http: 529, type: 'overloaded_error' });
  assert.match((await A('PUT', '/ai/key', { key: KEY })).data.error, /momentanément indisponible/);
  queue.push({ http: 429, type: 'rate_limit_error' });
  assert.match((await A('PUT', '/ai/key', { key: KEY })).data.error, /Réessayez dans une minute/);
  assert.equal(seen.length, n + 5, 'un seul essai par tentative');
  for (const s of seen.slice(n)) { assert.equal(s.key, KEY, 'l\'essai se fait avec la clé collée'); assert.equal(s.bearer, null); }
  // aucun message d'erreur ne répète la clé, et rien n'est enregistré
  assert.equal(fs.existsSync(KEY_FILE), false);
  assert.equal(await aiOn(), false);
  assert.equal((await A('GET', '/ai/key')).data.source, null);
});

test('clé valable : enregistrée, active tout de suite, jamais renvoyée', async () => {
  const n = seen.length;
  const ok = await A('PUT', '/ai/key', { key: `  ${KEY}\n` });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.data, { source: 'settings', hint: 'sk-ant-…WXYZ', model: 'claude-opus-5', env: false });
  assert.equal(seen.length, n + 1);
  assert.equal(seen.at(-1).url, '/v1/messages');
  assert.equal(seen.at(-1).body.model, 'claude-opus-5');
  assert.ok(seen.at(-1).body.max_tokens <= 64, 'essai très court');
  // rangée dans le dossier des données, lisible seulement par le compte qui fait tourner le logiciel
  assert.equal(fs.readFileSync(KEY_FILE, 'utf8').trim(), KEY);
  if (process.platform !== 'win32') assert.equal(fs.statSync(KEY_FILE).mode & 0o777, 0o600);
  // active sans redémarrer : « Écouter le client » fonctionne, avec cette clé
  assert.equal(await aiOn(), true);
  queue.push({ text: JSON.stringify({ resume: 'Bruit au freinage.', a_preciser: [] }) });
  const sum = await A('POST', '/documents/request-summary', { type: 'order', transcript: 'bruit au freinage' });
  assert.equal(sum.status, 200, sum.text);
  assert.equal(seen.at(-1).key, KEY);

  // la clé n'apparaît dans aucune réponse du logiciel, ni dans la base
  const office = await (async () => {
    await A('POST', '/users', { name: 'Bureau', email: 'b@t.lu', role: 'office', password: 'secret123', permissions: { ia: 'manager', atelier: 'manager', ventes: 'manager' } });
    return (await call('POST', '/auth/login', { email: 'b@t.lu', password: 'secret123' })).data.token;
  })();
  for (const [url, tok] of [['/ai/key', admin], ['/settings', admin], ['/settings', office], ['/auth/status', null], ['/auth/status', admin], ['/odoo', admin], ['/copilot', admin], ['/agents', admin]]) {
    const r = await call('GET', url, undefined, tok);
    assert.ok(!r.text.includes(KEY) && !r.text.includes(KEY.slice(8, 40)), `la clé ne doit pas sortir par ${url}`);
  }
  for (const f of fs.readdirSync(dataDir).filter((x) => x !== 'claude.key')) {
    const p = path.join(dataDir, f);
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p).includes(KEY), `la clé ne doit pas être dans ${f}`);
  }
  assert.ok(!server.out().includes(KEY), 'ni dans le journal du serveur');

  // réservé à l'administrateur
  assert.equal((await call('GET', '/ai/key', undefined, office)).status, 403);
  assert.equal((await call('PUT', '/ai/key', { key: KEY2 }, office)).status, 403);
  assert.equal((await call('DELETE', '/ai/key', undefined, office)).status, 403);
  assert.equal((await call('GET', '/ai/key')).status, 401);
  assert.equal((await call('PUT', '/ai/key', { key: KEY2 })).status, 401);
  assert.equal(fs.readFileSync(KEY_FILE, 'utf8').trim(), KEY);
});

test('remplacer la clé : l\'ancienne reste si la nouvelle est refusée', async () => {
  queue.push({ http: 401, type: 'authentication_error' });
  assert.equal((await A('PUT', '/ai/key', { key: KEY2 })).status, 400);
  assert.equal((await A('GET', '/ai/key')).data.hint, 'sk-ant-…WXYZ');
  assert.equal(fs.readFileSync(KEY_FILE, 'utf8').trim(), KEY);
  const ok = await A('PUT', '/ai/key', { key: KEY2 });
  assert.equal(ok.data.hint, 'sk-ant-…QRST');
  queue.push({ text: JSON.stringify({ resume: 'Vidange.', a_preciser: [] }) });
  await A('POST', '/documents/request-summary', { type: 'order', transcript: 'vidange' });
  assert.equal(seen.at(-1).key, KEY2, 'les demandes suivantes partent avec la nouvelle clé');
});

test('après un redémarrage la clé est toujours là ; elle passe avant celle du fichier .env ; retirée, celle du .env reprend', async () => {
  await stop();
  await start({ ANTHROPIC_API_KEY: ENV_KEY });
  admin = await login();
  assert.equal(await aiOn(), true);
  assert.deepEqual((await A('GET', '/ai/key')).data, { source: 'settings', hint: 'sk-ant-…QRST', model: 'claude-opus-5', env: true });
  queue.push({ text: JSON.stringify({ resume: 'Vidange.', a_preciser: [] }) });
  await A('POST', '/documents/request-summary', { type: 'order', transcript: 'vidange' });
  assert.equal(seen.at(-1).key, KEY2);

  const gone = await A('DELETE', '/ai/key');
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.data, { source: 'env', hint: 'sk-ant-…ENV1', model: 'claude-opus-5', env: true });
  assert.equal(fs.existsSync(KEY_FILE), false);
  queue.push({ text: JSON.stringify({ resume: 'Vidange.', a_preciser: [] }) });
  await A('POST', '/documents/request-summary', { type: 'order', transcript: 'vidange' });
  assert.equal(seen.at(-1).key, ENV_KEY);
  assert.equal((await A('DELETE', '/ai/key')).status, 200, 'retirer deux fois ne casse rien');

  // sans aucune clé : retour au mode démo
  await stop();
  await start();
  admin = await login();
  assert.equal(await aiOn(), false);
  assert.equal((await A('GET', '/ai/key')).data.source, null);
});
