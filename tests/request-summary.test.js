// « Écouter le client » : la demande dictée à l'accueil est résumée par l'IA pour le mécanicien (devis et OR).
// Le service d'IA est simulé : on vérifie ce qui lui est envoyé, ce qui revient à l'écran, les refus et les droits.
process.env.TZ ||= 'Europe/Luxembourg';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 5100 + Math.floor(Math.random() * 80);
const dirs = ['garage-voice-', 'garage-voice-nokey-', 'garage-voice-direct-'].map((d) => fs.mkdtempSync(path.join(os.tmpdir(), d)));
const servers = [];
let admin, vehicle;

// Faux service d'IA : répond ce qu'on a mis dans la file et garde les demandes reçues
const queue = [];
const seen = [];
const claude = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    seen.push(JSON.parse(b));
    const next = queue.shift() || { stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] };
    if (next.hang) return; // le service accepte la demande et ne répond jamais
    if (next.http) { res.writeHead(next.http, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: ERRORS[next.http] || 'api_error', message: 'Detail in English' }, request_id: 'req_test' })); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'test', usage: { input_tokens: 1, output_tokens: 1 }, ...next }));
  });
});
const ERRORS = { 400: 'invalid_request_error', 401: 'authentication_error', 404: 'not_found_error', 529: 'overloaded_error' };
const answer = (obj) => queue.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });

async function call(method, url, body, tok, port = PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* pas de JSON */ }
  return { status: res.status, data };
}
const A = (method, url, body) => call(method, url, body, admin);
const sum = (body, tok = admin, port = PORT) => call('POST', '/documents/request-summary', body, tok, port);
async function start(port, dataDir, env) {
  let out = '';
  const s = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, PUBLIC_URL: '', ...env }, stdio: 'pipe' });
  servers.push(s);
  s.stdout.on('data', (d) => { out += d; });
  s.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 80 && !/démarré/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  const r = await call('POST', '/auth/setup', { name: 'Gérant', email: 'g@t.lu', password: 'secret123', company: 'Garage Test' }, null, port);
  assert.equal(r.status, 200, out);
  return r.data.token;
}
async function userWith(perms, name) {
  const email = `${name}@t.lu`;
  await A('POST', '/users', { name, email, role: 'office', password: 'secret123', permissions: perms });
  return (await call('POST', '/auth/login', { email, password: 'secret123' })).data.token;
}

const SAID = 'bonjour alors voilà euh   depuis deux semaines j\'ai un bruit à l\'avant gauche quand je freine\n\n surtout le matin et il faudrait faire l\'entretien aussi je m\'appelle Jean Muller';

before(async () => {
  await new Promise((r) => claude.listen(0, '127.0.0.1', r));
  admin = await start(PORT, dirs[0], { ANTHROPIC_API_KEY: 'test', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${claude.address().port}` });
  const cust = (await A('POST', '/customers', { name: 'Jean Muller' })).data.id;
  vehicle = (await A('POST', '/vehicles', { customer_id: cust, make: 'Volkswagen', model: 'Golf', year: 2018, fuel: 'Diesel', plate: 'AB 1234', vin: 'WVWZZZ1KZAW000001', mileage: 98000 })).data.id;
});
after(() => { for (const s of servers) s.kill(); claude.closeAllConnections(); claude.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('le texte dicté devient une demande claire pour le mécanicien', async () => {
  answer({
    resume: '## Demande\n1. **Bruit à l\'avant gauche au freinage**, depuis 2 semaines, surtout le matin.\n\n* Entretien à faire.\nSouhaits du client : aucun délai précisé.',
    a_preciser: ['Quel entretien (annuel, vidange seule) ?', '  Un voyant est-il allumé ?  ', 'Pour quand ?', 'Une quatrième question en trop'],
  });
  const r = await sum({ type: 'order', transcript: SAID, vehicle_id: vehicle, mileage: 123456, lang: 'fr' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // texte simple : plus de Markdown, pas de ligne vide
  assert.equal(r.data.summary, 'Demande\n1. Bruit à l\'avant gauche au freinage, depuis 2 semaines, surtout le matin.\n- Entretien à faire.\nSouhaits du client : aucun délai précisé.');
  assert.deepEqual(r.data.questions, ['Quel entretien (annuel, vidange seule) ?', 'Un voyant est-il allumé ?', 'Pour quand ?'], 'trois questions au plus');

  // ce qui est parti vers l'IA
  const req = seen.at(-1);
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.output_config.effort, 'low', 'tâche simple : réponse rapide');
  assert.match(req.system, /mécanicien/);
  const sent = req.messages[0].content;
  assert.equal(req.messages.length, 1);
  assert.match(sent, /<transcription>\nbonjour alors voilà euh depuis deux semaines .* quand je freine\nsurtout le matin .*\n<\/transcription>/, 'texte remis au propre, entre balises');
  assert.match(sent, /Véhicule : Volkswagen Golf \(2018, Diesel\), 123456 km/, 'le kilométrage du document passe avant celui de la fiche');
  assert.match(sent, /Langue parlée à l'accueil : français/);
  // rien qui identifie le client n'est ajouté par le logiciel (ni plaque, ni châssis)
  assert.doesNotMatch(sent, /AB 1234|WVWZZZ/);
  assert.doesNotMatch(req.system, /Muller/);

  // sans véhicule, autre langue, sur un devis
  answer({ resume: 'Vidange.', a_preciser: [] });
  const q = await sum({ type: 'quote', transcript: 'ich möchte einen Ölwechsel', lang: 'de' });
  assert.equal(q.status, 200);
  assert.deepEqual(q.data, { summary: 'Vidange.', questions: [] });
  assert.match(seen.at(-1).messages[0].content, /Véhicule : non précisé\nLangue parlée à l'accueil : allemand/);
  // le kilométrage de la fiche du véhicule sert quand le document n'en a pas
  answer({ resume: 'Vidange.', a_preciser: [] });
  await sum({ type: 'order', transcript: 'vidange', vehicle_id: vehicle });
  assert.match(seen.at(-1).messages[0].content, /98000 km/);
});

test('demandes refusées avant tout envoi à l\'IA', async () => {
  const n = seen.length;
  assert.equal((await sum({ type: 'order', transcript: '   \n ' })).status, 400, 'rien à résumer');
  assert.equal((await sum({ type: 'order' })).status, 400);
  const long = await sum({ type: 'order', transcript: 'bruit '.repeat(2100) });
  assert.equal(long.status, 400);
  assert.match(long.data.error, /trop long/i, 'jamais coupé en silence');
  assert.equal((await sum({ type: 'invoice', transcript: 'bruit' })).status, 400, 'seulement devis et OR');
  assert.equal((await sum({ transcript: 'bruit' })).status, 400);
  // autre chose qu'un texte (demande fabriquée à la main) : refusé proprement, jamais une erreur interne
  for (const transcript of [{ a: 1 }, ['bruit', 'frein'], 42, true, { toString: 1 }]) {
    const r = await sum({ type: 'quote', transcript });
    assert.equal(r.status, 400, JSON.stringify(transcript));
    assert.match(r.data.error, /invalide/);
  }
  assert.equal(seen.length, n, 'rien n\'est parti vers l\'IA');
  // une langue qui n'est pas un texte : le français par défaut
  answer({ resume: 'Bruit.', a_preciser: [] });
  assert.equal((await sum({ type: 'quote', transcript: 'bruit', lang: { toString: 1 } })).status, 200);
  assert.match(seen.at(-1).messages[0].content, /Langue parlée à l'accueil : français/);
});

test('réponses inutilisables de l\'IA : un message clair, jamais un texte vide', async () => {
  answer({ resume: '  ', a_preciser: [] });
  const empty = await sum({ type: 'order', transcript: 'il fait beau aujourd\'hui' });
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /aucune demande/);

  queue.push({ stop_reason: 'refusal', content: [] });
  const refused = await sum({ type: 'order', transcript: 'bruit au freinage' });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /tel quel/);

  answer('ceci n\'est pas du JSON');
  const broken = await sum({ type: 'order', transcript: 'bruit au freinage' });
  assert.equal(broken.status, 400);
  assert.match(broken.data.error, /n'a pas pu résumer/);

  // réponse coupée (toute la place prise par la réflexion) ou vide : « réessayez », et non « aucune demande trouvée »
  for (const reply of [{ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '', signature: 's' }] }, { stop_reason: 'end_turn', content: [] }, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'null' }] },
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"resume":"Bruit au","a_preciser":[]}' }] }]) {
    queue.push(reply);
    const cut = await sum({ type: 'order', transcript: 'bruit au freinage avant gauche' });
    assert.equal(cut.status, 400);
    assert.match(cut.data.error, /n'a pas pu résumer/, JSON.stringify(reply));
  }
});

test('pannes du service d\'IA : une seule tentative, un message en français', async () => {
  const body = { type: 'order', transcript: 'bruit au freinage' };
  queue.push({ http: 401 });
  const key = await sum(body);
  assert.equal(key.status, 400);
  assert.match(key.data.error, /Clé API Claude invalide/);

  let n = seen.length;
  queue.push({ http: 529 });
  const busy = await sum(body);
  assert.equal(busy.status, 400);
  assert.match(busy.data.error, /momentanément indisponible.*tel quel/);
  assert.doesNotMatch(busy.data.error, /English|overloaded|req_test|\{/, 'pas de message technique en anglais à l\'accueil');
  assert.equal(seen.length, n + 1, 'pas de seconde tentative cachée');

  queue.push({ http: 404 });
  const model = await sum(body);
  assert.equal(model.status, 400);
  assert.match(model.data.error, /erreur 404.*administrateur/);
  assert.doesNotMatch(model.data.error, /English|req_test/);

  // modèle plus ancien qui refuse le réglage d'effort : la demande repart sans lui
  n = seen.length;
  queue.push({ http: 400 });
  answer({ resume: 'Bruit au freinage.', a_preciser: [] });
  const old = await sum(body);
  assert.equal(old.status, 200, JSON.stringify(old.data));
  assert.equal(seen.length, n + 2);
  assert.equal(seen.at(-2).output_config.effort, 'low');
  assert.equal(seen.at(-1).output_config.effort, undefined);
  assert.equal(seen.at(-1).output_config.format.type, 'json_schema');
  // refus répété : message clair, deux essais au plus
  n = seen.length;
  queue.push({ http: 400 }, { http: 400 });
  const bad = await sum(body);
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /erreur 400/);
  assert.equal(seen.length, n + 2);
});

test('l\'IA ne répond pas : attente bornée, une seule demande, message juste', async () => {
  // module chargé directement, pour raccourcir l'attente maximale (45 s dans le logiciel)
  Object.assign(process.env, { DATA_DIR: dirs[2], ANTHROPIC_API_KEY: 'test', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${claude.address().port}` });
  const { summarizeRequest } = await import('../src/request-summary.js');
  const n = seen.length;
  queue.push({ hang: true });
  const t0 = Date.now();
  await assert.rejects(summarizeRequest({ transcript: 'bruit au freinage' }, { timeout: 400 }), (e) => {
    assert.match(e.message, /trop de temps/);
    assert.doesNotMatch(e.message, /connexion internet/, 'ce n\'est pas une panne de connexion');
    assert.equal(e.status, 400);
    return true;
  });
  assert.ok(Date.now() - t0 < 3000, `attente de ${Date.now() - t0} ms`);
  assert.equal(seen.length, n + 1, 'la demande n\'est pas renvoyée une seconde fois');
});

test('droits : ceux du document (OR → Atelier, devis → Ventes)', async () => {
  const ventes = await userWith({ ventes: 'user' }, 'vendeur');
  const atelier = await userWith({ atelier: 'user' }, 'chef');
  const lecteur = await userWith({ atelier: 'read', ventes: 'read' }, 'lecteur');
  const body = (type) => ({ type, transcript: 'bruit au freinage' });
  const n = seen.length;
  assert.equal((await sum(body('order'), ventes)).status, 403);
  assert.equal((await sum(body('quote'), atelier)).status, 403);
  assert.equal((await sum(body('order'), lecteur)).status, 403);
  assert.equal((await sum(body('quote'), lecteur)).status, 403);
  assert.equal((await sum(body('order'), null)).status, 401);
  assert.equal(seen.length, n, 'rien n\'est parti vers l\'IA');
  answer({ resume: 'Bruit au freinage.', a_preciser: [] });
  assert.equal((await sum(body('quote'), ventes)).status, 200);
  answer({ resume: 'Bruit au freinage.', a_preciser: [] });
  assert.equal((await sum(body('order'), atelier)).status, 200);
});

test('sans clé IA : refus explicite, rien n\'est envoyé', async () => {
  const tok = await start(PORT + 100, dirs[1], { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${claude.address().port}` });
  const n = seen.length;
  const r = await sum({ type: 'order', transcript: 'bruit au freinage' }, tok, PORT + 100);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /aucune clé/);
  assert.match(r.data.error, /tel quel/);
  assert.equal(seen.length, n);
});
