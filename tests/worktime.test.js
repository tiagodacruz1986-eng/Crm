// Temps atelier : temps prévu par intervention, chronos à la tablette, dépassements, statistiques par mécanicien.
// Le test démarre un vrai serveur sur une base vide et passe par l'API, comme le navigateur et la tablette.
// (même fuseau que le serveur : les pointages sont enregistrés à l'heure du garage)
process.env.TZ ||= 'Europe/Luxembourg';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4500 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-worktime-'));
let server, admin, customer;

async function call(method, url, body, tok) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const A = (method, url, body) => call(method, url, body, admin);
const pad = (n) => String(n).padStart(2, '0');
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const day = (d) => local(d).slice(0, 10);
const ago = (hours) => new Date(Date.now() - hours * 3600000);
// période large : hier → aujourd'hui (un chrono reculé de quelques heures peut tomber la veille)
const RANGE = () => `from=${day(ago(30))}&to=${day(new Date())}`;
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

/** Crée un mécanicien et ouvre sa session sur la tablette. */
async function mechanic(name) {
  const id = (await A('POST', '/users', { name, role: 'mechanic', pin: '4321' })).data.id;
  const tok = (await call('POST', '/kiosk/login', { user_id: id })).data.token;
  assert.ok(tok, 'session tablette');
  return { id, tok };
}
/** OR avec deux interventions (main-d'œuvre), un forfait et une pièce. */
async function order(lines) {
  const r = await A('POST', '/documents', { type: 'order', customer_id: customer, lines: lines || [
    { kind: 'labor', description: 'Vidange', quantity: 1, unit_price: 80, tax_rate: 17 },
    { kind: 'labor', description: 'Plaquettes AV', quantity: 1.5, unit_price: 80, tax_rate: 17, planned_hours: 1 },
    { kind: 'fee', description: 'Forfait climatisation', quantity: 1, unit_price: 89, tax_rate: 17, planned_hours: 0.5 },
    { kind: 'part', description: 'Filtre à huile', quantity: 1, unit_price: 14, tax_rate: 17 },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return (await A('GET', `/documents/${r.data.id}`)).data;
}
/** Recule le début du chrono en cours d'un mécanicien (comme une correction du gérant) pour simuler du temps passé. */
async function backdate(userId, hours) {
  const list = (await A('GET', `/timesheets?${RANGE()}`)).data.entries;
  const e = list.find((x) => x.user_id === userId && x.kind === 'work' && !x.end);
  assert.ok(e, 'chrono en cours');
  assert.equal((await A('PUT', `/timesheets/${e.id}`, { start: local(ago(hours)) })).status, 200);
  return e;
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
  await A('PUT', '/settings', { attendance: { kiosk_pin: false } });
  customer = (await A('POST', '/customers', { name: 'Client atelier' })).data.id;
});
after(() => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('temps prévu : saisi par le gérant, sinon heures vendues de la main-d\'œuvre', async () => {
  const d = await order();
  const [vidange, plaquettes, clim, piece] = d.lines;
  assert.equal(vidange.planned, 1, 'main-d\'œuvre sans saisie : heures vendues');
  assert.equal(plaquettes.planned, 1, 'temps saisi par le gérant (différent des 1,5 h vendues)');
  assert.equal(clim.planned, 0.5, 'forfait : temps saisi');
  assert.equal(piece.planned, undefined, 'une pièce n\'est pas une intervention');
  assert.equal(d.hours_planned, 2.5);
  assert.equal(d.hours_spent, 0);

  // valeurs refusées
  for (const bad of ['abc', -1, 5000]) {
    const r = await A('PUT', `/documents/${d.id}`, { ...d, lines: d.lines.map((l, i) => (i === 0 ? { ...l, planned_hours: bad } : l)) });
    assert.equal(r.status, 400, `temps prévu ${bad} refusé`);
  }
  // « 1,5 » (virgule) accepté ; champ vidé : retour aux heures vendues ; 0 : pas de temps prévu
  let cur = (await A('GET', `/documents/${d.id}`)).data;
  assert.equal((await A('PUT', `/documents/${d.id}`, { ...cur, lines: cur.lines.map((l, i) => (i === 0 ? { ...l, planned_hours: '2,25' } : i === 1 ? { ...l, planned_hours: '' } : i === 2 ? { ...l, planned_hours: 0 } : l)) })).status, 200);
  cur = (await A('GET', `/documents/${d.id}`)).data;
  assert.equal(cur.lines[0].planned, 2.25);
  assert.equal(cur.lines[1].planned, 1.5, 'vide : heures vendues');
  assert.equal(cur.lines[2].planned, null, '0 : pas de temps prévu');
  assert.equal(cur.hours_planned, 3.75);
  // un enregistrement qui ne transmet pas le champ (ancien écran, assistant) ne l'efface pas
  const without = cur.lines.map(({ planned_hours, ...l }) => l);
  assert.equal((await A('PUT', `/documents/${d.id}`, { ...cur, lines: without })).status, 200);
  assert.equal((await A('GET', `/documents/${d.id}`)).data.lines[0].planned, 2.25);
  // le temps prévu n'apparaît pas sur le suivi du client ; le lien du mécanicien ne montre que la liste des travaux
  for (const role of ['customer', 'mechanic']) {
    const tokn = (await A('POST', `/live/${d.id}/links`, { role })).data.token;
    assert.ok(tokn, 'lien de suivi');
    const pub = await fetch(`http://127.0.0.1:${PORT}/live-api/${tokn}`);
    assert.equal(pub.status, 200);
    assert.ok(!/planned/.test(await pub.text()), `${role} : pas de temps prévu dans le suivi`);
  }
});

test('tablette : chrono par intervention, un seul chrono par mécanicien, « fait » arrête le chrono', async () => {
  const m = await mechanic('Paulo');
  const d = await order();
  const other = await order();
  const [vidange, plaquettes, , piece] = d.lines;
  const K = (body) => call('POST', '/kiosk/clock', body, m.tok);

  // pièce ou ligne d'un autre OR : refusé
  assert.equal((await K({ action: 'start', document_id: d.id, line_id: piece.id })).status, 400, 'une pièce ne se chronomètre pas');
  assert.equal((await K({ action: 'start', document_id: d.id, line_id: other.lines[0].id })).status, 400, 'ligne d\'un autre OR');
  assert.equal((await K({ action: 'start', document_id: d.id, line_id: 'x' })).status, 400);

  let st = (await K({ action: 'start', document_id: d.id, line_id: plaquettes.id })).data;
  assert.equal(st.work.line_id, plaquettes.id);
  assert.equal(st.work.line_description, 'Plaquettes AV');
  let o = st.orders.find((x) => x.id === d.id);
  assert.equal(o.status, 'in_progress', 'démarrer met l\'OR en cours');
  assert.equal(o.lines.find((l) => l.id === plaquettes.id).active, 1);
  assert.equal(o.lines.find((l) => l.id === plaquettes.id).planned, 1);
  assert.equal(o.lines.find((l) => l.id === piece.id).timed, false);
  assert.equal(o.hours_planned, 2.5);

  // second appui sur le même travail : toujours un seul pointage
  await K({ action: 'start', document_id: d.id, line_id: plaquettes.id });
  let entries = (await A('GET', `/documents/${d.id}`)).data.time_entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].line_description, 'Plaquettes AV');

  // passer à une autre intervention ferme la précédente
  st = (await K({ action: 'start', document_id: d.id, line_id: vidange.id })).data;
  entries = (await A('GET', `/documents/${d.id}`)).data.time_entries;
  assert.equal(entries.length, 2);
  assert.equal(entries.filter((e) => !e.end).length, 1);
  assert.equal(st.work.line_id, vidange.id);

  // « fait » sur l'intervention : son chrono s'arrête
  st = (await call('POST', `/kiosk/orders/${d.id}`, { line_id: vidange.id, done: true }, m.tok)).data;
  assert.equal(st.work ?? null, null, 'plus de chrono en cours');
  assert.equal((await A('GET', `/documents/${d.id}`)).data.time_entries.filter((e) => !e.end).length, 0);

  // chrono sur l'OR entier (sans intervention précise)
  st = (await K({ action: 'start', document_id: d.id })).data;
  assert.equal(st.work.line_id, null);
  const doc = (await A('GET', `/documents/${d.id}`)).data;
  assert.equal(doc.general_active, 1);
  assert.equal(doc.active_workers, 1);
  // OR terminé par le bureau : le chrono s'arrête
  assert.equal((await A('POST', `/documents/${d.id}/status`, { status: 'done' })).status, 200);
  assert.equal((await A('GET', `/documents/${d.id}`)).data.active_workers, 0);
});

test('dépassement : le temps passe en rouge (OR, atelier, tableau de bord) et compte dans les statistiques', async () => {
  const m = await mechanic('Sergio');
  const d = await order();
  const plaquettes = d.lines[1]; // prévu 1 h
  await call('POST', '/kiosk/clock', { action: 'start', document_id: d.id, line_id: plaquettes.id }, m.tok);
  await backdate(m.id, 2); // le mécanicien y est depuis 2 h

  const doc = (await A('GET', `/documents/${d.id}`)).data;
  const line = doc.lines.find((l) => l.id === plaquettes.id);
  assert.ok(near(line.spent, 2), `temps passé sur l'intervention : ${line.spent}`);
  assert.ok(line.spent > line.planned, 'dépassement');
  assert.deepEqual(line.workers, ['Sergio']);
  assert.ok(near(doc.hours_spent, 2));

  // tableau de l'atelier : temps pointé / temps prévu de l'OR
  const card = (await A('GET', '/documents?type=order')).data.find((x) => x.id === d.id);
  assert.ok(near(card.hours_spent, 2) && card.hours_planned === 2.5, JSON.stringify([card.hours_spent, card.hours_planned]));

  // tableau de bord : « à l'atelier maintenant » montre l'intervention et le dépassement
  const dash = (await A('GET', '/dashboard')).data;
  const me = dash.present.find((p) => p.id === m.id);
  assert.equal(me.work.line, 'Plaquettes AV');
  assert.equal(me.work.over, true);
  assert.equal(me.work.planned, 1);

  // statistiques : dépassement compté même si l'intervention n'est pas terminée
  let stats = (await A('GET', `/timesheets/stats?${RANGE()}`)).data;
  let mine = stats.mechanics.find((x) => x.id === m.id);
  assert.equal(mine.overruns, 1);
  assert.equal(mine.interventions, 1);
  assert.ok(near(mine.planned, 1) && near(mine.spent, 2) && near(mine.gap, 1), JSON.stringify(mine));
  assert.equal(mine.efficiency, 50);
  assert.equal(mine.current.over, true);
  const unit = stats.interventions.find((x) => x.line_id === plaquettes.id);
  assert.ok(unit.over > 0.9 && unit.active === 1 && !unit.finished);
  assert.ok(stats.interventions[0].over > 0, 'les dépassements en tête de liste');

  // une intervention finie dans les temps ne compte pas comme dépassement
  await call('POST', '/kiosk/clock', { action: 'start', document_id: d.id, line_id: d.lines[0].id }, m.tok); // Vidange, prévu 1 h
  await backdate(m.id, 0.5);
  await call('POST', `/kiosk/orders/${d.id}`, { line_id: d.lines[0].id, done: true }, m.tok);
  stats = (await A('GET', `/timesheets/stats?${RANGE()}`)).data;
  mine = stats.mechanics.find((x) => x.id === m.id);
  assert.equal(mine.interventions, 2);
  assert.equal(mine.overruns, 1);
  assert.ok(near(mine.planned, 2) && near(mine.spent, 2.5), JSON.stringify(mine));
  assert.ok(near(mine.work, 2.5), 'heures sur OR de la période');
});

test('à deux sur la même intervention : le temps prévu est partagé au prorata', async () => {
  const a = await mechanic('Ana');
  const b = await mechanic('Bruno');
  const d = await order([{ kind: 'labor', description: 'Embrayage', quantity: 2, unit_price: 80, tax_rate: 17 }]);
  const line = d.lines[0];
  await call('POST', '/kiosk/clock', { action: 'start', document_id: d.id, line_id: line.id }, a.tok);
  await call('POST', '/kiosk/clock', { action: 'start', document_id: d.id, line_id: line.id }, b.tok);
  await backdate(a.id, 3);
  await backdate(b.id, 1);
  const doc = (await A('GET', `/documents/${d.id}`)).data;
  assert.equal(doc.lines[0].active, 2);
  assert.ok(near(doc.lines[0].spent, 4));
  await A('PUT', `/documents/${d.id}`, { ...doc, lines: doc.lines.map((l) => ({ ...l, done: 1 })) }); // le bureau coche « fait »
  assert.equal((await A('GET', `/documents/${d.id}`)).data.active_workers, 0, 'cocher « fait » au bureau arrête les chronos');
  const stats = (await A('GET', `/timesheets/stats?${RANGE()}`)).data;
  const sa = stats.mechanics.find((x) => x.id === a.id), sb = stats.mechanics.find((x) => x.id === b.id);
  assert.ok(near(sa.planned, 1.5) && near(sa.spent, 3), JSON.stringify(sa));
  assert.ok(near(sb.planned, 0.5) && near(sb.spent, 1), JSON.stringify(sb));
  assert.equal(sa.overruns, 1);
  assert.equal(sb.overruns, 1);
  const unit = stats.interventions.find((x) => x.line_id === line.id);
  assert.equal(unit.mechanics.split(', ').sort().join(','), 'Ana,Bruno');
  assert.ok(unit.finished && near(unit.over, 2));
});

test('bureau : ligne retirée, OR facturé ou supprimé — aucun temps perdu, aucun chrono oublié', async () => {
  const m = await mechanic('Carlos');
  const d = await order();
  await call('POST', '/kiosk/clock', { action: 'start', document_id: d.id, line_id: d.lines[2].id }, m.tok); // forfait climatisation
  await backdate(m.id, 1);
  await call('POST', '/kiosk/clock', { action: 'stop' }, m.tok);
  // le bureau retire la ligne : le temps reste sur l'OR, sans intervention précise
  let doc = (await A('GET', `/documents/${d.id}`)).data;
  assert.equal((await A('PUT', `/documents/${d.id}`, { ...doc, lines: doc.lines.filter((l) => l.id !== d.lines[2].id) })).status, 200);
  doc = (await A('GET', `/documents/${d.id}`)).data;
  assert.ok(near(doc.hours_spent, 1) && near(doc.hours_general, 1), JSON.stringify([doc.hours_spent, doc.hours_general]));
  assert.equal(doc.time_entries[0].line_description, null);
  // statistiques : ce temps « général » se compare au temps prévu des interventions sans chrono propre (1 h + 1 h)
  const unit = (await A('GET', `/timesheets/stats?${RANGE()}`)).data.interventions.find((x) => x.document_id === d.id);
  assert.equal(unit.line_id, null);
  assert.equal(unit.planned, 2);
  assert.equal(unit.over, 0);

  // OR facturé pendant qu'un chrono tourne : il s'arrête, et on ne peut plus pointer dessus
  await call('POST', '/kiosk/clock', { action: 'start', document_id: d.id, line_id: d.lines[0].id }, m.tok);
  assert.equal((await A('POST', `/documents/${d.id}/convert`, { type: 'invoice' })).status, 200);
  assert.equal((await A('GET', `/documents/${d.id}`)).data.active_workers, 0);
  assert.equal((await call('POST', '/kiosk/clock', { action: 'start', document_id: d.id, line_id: d.lines[0].id }, m.tok)).status, 400);

  // OR supprimé pendant qu'un chrono tourne : le pointage est fermé (il ne tourne pas indéfiniment)
  const e = await order();
  await call('POST', '/kiosk/clock', { action: 'start', document_id: e.id, line_id: e.lines[0].id }, m.tok);
  assert.equal((await A('DELETE', `/documents/${e.id}`)).status, 200);
  const st = (await call('GET', '/kiosk/state', undefined, m.tok)).data;
  assert.equal(st.work ?? null, null);
});

test('droits : statistiques des mécaniciens réservées au droit Présences', async () => {
  const mk = async (perms, name) => {
    const email = `${name}@t.lu`;
    await A('POST', '/users', { name, email, role: 'office', password: 'secret123', permissions: perms });
    return (await call('POST', '/auth/login', { email, password: 'secret123' })).data.token;
  };
  const atelier = await mk({ atelier: 'user' }, 'atelier');
  assert.equal((await call('GET', `/timesheets/stats?${RANGE()}`, undefined, atelier)).status, 403);
  assert.deepEqual((await call('GET', '/dashboard', undefined, atelier)).data.present, []);
  const rh = await mk({ presences: 'read' }, 'rh');
  const r = await call('GET', `/timesheets/stats?${RANGE()}`, undefined, rh);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.mechanics) && Array.isArray(r.data.interventions));
  // dates invalides ou période démesurée : pas d'erreur serveur
  assert.ok([200, 400].includes((await A('GET', '/timesheets/stats?from=abc&to=2026-13-45')).status));
});
