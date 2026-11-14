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
import { DatabaseSync } from 'node:sqlite';

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
/** Écrit directement dans la base du serveur de test (ce que seul le serveur fait d'habitude, p. ex. l'arrêt automatique d'un chrono oublié). */
function sql(query, ...params) {
  const d = new DatabaseSync(path.join(dataDir, 'garage.db'));
  try { d.exec('PRAGMA busy_timeout=3000'); return d.prepare(query).run(...params); } finally { d.close(); }
}
const K = (tok, body) => call('POST', '/kiosk/clock', body, tok);
const statsOf = async (userId, range = RANGE()) => (await A('GET', `/timesheets/stats?${range}`)).data.mechanics.find((x) => x.id === userId);
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
  assert.equal(sa.overruns, 1, 'le dépassement est compté à celui qui a passé le plus de temps');
  assert.equal(sb.overruns, 0, 'celui qui est venu aider (un quart du temps) ne reçoit pas de dépassement');
  assert.ok(near(sb.gap, 0.5), 'mais sa part du temps en trop reste visible dans l\'écart');
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

test('chiffres justes : temps pointé sur l\'OR entier, interventions sans temps prévu, aide ponctuelle', async () => {
  const k = await mechanic('Kevin');
  const s = await mechanic('Sven');
  // Kevin pointe 3 h sur l'OR sans choisir d'intervention ; Sven aide 20 minutes sur l'embrayage
  const d = await order([
    { kind: 'labor', description: 'Embrayage', quantity: 3, unit_price: 80, tax_rate: 17 },
    { kind: 'labor', description: 'Géométrie', quantity: 1, unit_price: 80, tax_rate: 17 },
  ]);
  await K(k.tok, { action: 'start', document_id: d.id });
  await backdate(k.id, 3);
  await K(k.tok, { action: 'stop' });
  await K(s.tok, { action: 'start', document_id: d.id, line_id: d.lines[0].id });
  await backdate(s.id, 1 / 3);
  await K(s.tok, { action: 'stop' });
  await A('POST', `/documents/${d.id}/status`, { status: 'done' });
  // Sven : 20 min sur une intervention prévue 3 h, mais Kevin a aussi travaillé dessus sans le dire → pas de faux gain pour Sven ;
  // Kevin : ses 3 h sont comparées à ce qui reste du temps prévu de l'OR (4 h − 20 min) → pas de faux dépassement
  const sk = await statsOf(k.id), ss = await statsOf(s.id);
  assert.equal(sk.overruns, 0, JSON.stringify(sk));
  assert.ok(near(sk.planned, 4 - 1 / 3, 0.03) && near(sk.spent, 3), JSON.stringify(sk));
  assert.ok(near(ss.planned, 1 / 3, 0.03) && near(ss.spent, 1 / 3) && near(ss.gap, 0, 0.03), JSON.stringify(ss));
  assert.equal(ss.overruns, 0);
  // la somme des écarts des deux mécaniciens = temps passé − temps prévu de l'OR (3 h 20 − 4 h)
  assert.ok(near(sk.gap + ss.gap, 3 + 1 / 3 - 4, 0.04), JSON.stringify([sk.gap, ss.gap]));
  const units = (await A('GET', `/timesheets/stats?${RANGE()}`)).data.interventions.filter((x) => x.document_id === d.id);
  assert.equal(units.length, 2, 'l\'intervention chronométrée + le reste de l\'OR');
  assert.ok(units.every((u) => u.over === 0), JSON.stringify(units));
  assert.ok(near(units.find((u) => u.whole).planned, 4 - 1 / 3, 0.03));

  // un dépassement sur une intervention reste visible même si un peu de temps « général » a été pointé sur l'OR
  const g = await order([
    { kind: 'labor', description: 'Plaquettes', quantity: 1, unit_price: 80, tax_rate: 17 },
    { kind: 'labor', description: 'Purge', quantity: 1, unit_price: 80, tax_rate: 17 },
  ]);
  await K(k.tok, { action: 'start', document_id: g.id, line_id: g.lines[0].id });
  await backdate(k.id, 1.5);
  await call('POST', `/kiosk/orders/${g.id}`, { line_id: g.lines[0].id, done: true }, k.tok);
  await K(k.tok, { action: 'start', document_id: g.id });
  await backdate(k.id, 0.1);
  await K(k.tok, { action: 'stop' });
  const gu = (await A('GET', `/timesheets/stats?${RANGE()}`)).data.interventions.filter((x) => x.document_id === g.id);
  assert.ok(near(gu.find((u) => u.line_id === g.lines[0].id).over, 0.5), 'intervention dépassée de 30 min');
  assert.equal((await statsOf(k.id)).overruns, 1);
  // tout le temps prévu consommé puis encore du travail « général » : ce temps en plus est un dépassement de l'OR
  await A('POST', `/documents/${g.id}/status`, { status: 'in_progress' });
  await K(k.tok, { action: 'start', document_id: g.id, line_id: g.lines[1].id });
  await backdate(k.id, 1);
  await call('POST', `/kiosk/orders/${g.id}`, { line_id: g.lines[1].id, done: true }, k.tok);
  const rest = (await A('GET', `/timesheets/stats?${RANGE()}`)).data.interventions.find((x) => x.document_id === g.id && x.whole);
  assert.ok(rest.planned === 0 && near(rest.over, 0.1) && rest.finished, JSON.stringify(rest));
  assert.equal((await A('GET', `/documents/${d.id}`)).data.hours_planned, 4);

  // forfait sans temps prévu : le temps passé dessus ne met jamais l'OR en rouge
  const e = await order([
    { kind: 'labor', description: 'Freins', quantity: 2, unit_price: 80, tax_rate: 17 },
    { kind: 'fee', description: 'Forfait nettoyage', quantity: 1, unit_price: 50, tax_rate: 17 },
  ]);
  await K(k.tok, { action: 'start', document_id: e.id, line_id: e.lines[0].id });
  await backdate(k.id, 1.5);
  await K(k.tok, { action: 'start', document_id: e.id, line_id: e.lines[1].id });
  await backdate(k.id, 2);
  const doc = (await A('GET', `/documents/${e.id}`)).data;
  assert.ok(near(doc.hours_spent, 3.5) && near(doc.hours_unplanned, 2) && doc.hours_planned === 2, JSON.stringify([doc.hours_spent, doc.hours_unplanned, doc.hours_planned]));
  const card = (await A('GET', '/documents?type=order')).data.find((x) => x.id === e.id);
  assert.ok(near(card.hours_unplanned, 2) && card.hours_spent - card.hours_unplanned < card.hours_planned, 'tableau de l\'atelier : pas de rouge');
  const quote = (await A('GET', '/documents?type=order,quote')).data;
  assert.ok(quote.every((x) => x.type === 'order' || x.hours_planned === null), 'temps prévu calculé pour les OR seulement');
  const me = (await A('GET', '/dashboard')).data.present.find((p) => p.id === k.id);
  assert.equal(me.work.over, false, 'intervention sans temps prévu : jamais en dépassement');
  assert.equal(me.work.planned, null);
  await K(k.tok, { action: 'stop' });

  // facture créée depuis l'OR : le temps prévu (donnée d'atelier) n'y est pas recopié
  const planned = await order();
  const inv = (await A('POST', `/documents/${planned.id}/convert`, { type: 'invoice' })).data.id;
  assert.ok((await A('GET', `/documents/${inv}`)).data.lines.every((l) => l.planned_hours === null), 'pas de temps prévu sur la facture');
});

test('tablette : reprise d\'une intervention « faite », OR en attente de pièces, correction dans le futur refusée', async () => {
  const m = await mechanic('Rui');
  const d = await order();
  const line = d.lines[0];
  await K(m.tok, { action: 'start', document_id: d.id, line_id: line.id });
  await call('POST', `/kiosk/orders/${d.id}`, { line_id: line.id, done: true }, m.tok);
  assert.equal((await A('GET', `/documents/${d.id}`)).data.lines[0].done, 1);
  // reprise : la ligne redevient « à faire » (elle ne reste pas cochée avec un chrono en marche)
  await K(m.tok, { action: 'start', document_id: d.id, line_id: line.id });
  let doc = (await A('GET', `/documents/${d.id}`)).data;
  assert.equal(doc.lines[0].done, 0);
  assert.equal(doc.lines[0].active, 1);
  // OR passé « attente pièces » pendant que le chrono tourne ; nouvel appui sur la même intervention : l'OR repasse « en cours »
  await call('POST', `/kiosk/orders/${d.id}`, { status: 'waiting_parts' }, m.tok);
  await K(m.tok, { action: 'start', document_id: d.id, line_id: line.id });
  doc = (await A('GET', `/documents/${d.id}`)).data;
  assert.equal(doc.status, 'in_progress');
  assert.equal(doc.time_entries.filter((e) => !e.end).length, 1, 'toujours un seul chrono');
  // un pointage ne peut pas être corrigé pour commencer dans le futur
  const e = await backdate(m.id, 0.5);
  assert.equal((await A('PUT', `/timesheets/${e.id}`, { start: local(new Date(Date.now() + 3 * 3600000)) })).status, 400);
  await K(m.tok, { action: 'stop' });
});

test('statistiques : chrono oublié « à vérifier », mécanicien désactivé, intervention sur deux jours', async () => {
  const m = await mechanic('Tiago');
  const d = await order([{ kind: 'labor', description: 'Pneus hiver', quantity: 1, unit_price: 80, tax_rate: 17 }]);
  await K(m.tok, { action: 'start', document_id: d.id, line_id: d.lines[0].id });
  const e = await backdate(m.id, 2);
  await K(m.tok, { action: 'stop' });
  // le serveur arrête de lui-même un chrono oublié et le marque : la durée est une estimation
  sql("UPDATE time_entries SET source='auto' WHERE id=?", e.id);
  let st = await statsOf(m.id);
  assert.equal(st.to_check, 1);
  assert.equal(st.overruns, 0, 'un chrono oublié n\'est pas compté comme un dépassement');
  assert.equal(st.interventions, 0);
  let unit = (await A('GET', `/timesheets/stats?${RANGE()}`)).data.interventions.find((x) => x.document_id === d.id);
  assert.equal(unit.auto, true);
  const doc = (await A('GET', `/documents/${d.id}`)).data;
  assert.equal(doc.lines[0].auto, true);
  assert.equal(doc.time_entries[0].auto, true);
  // le gérant corrige les heures : l'intervention est jugée normalement
  assert.equal((await A('PUT', `/timesheets/${e.id}`, { start: local(ago(2)), end: local(ago(0.5)) })).status, 200);
  st = await statsOf(m.id);
  assert.equal(st.to_check, 0);
  assert.equal(st.overruns, 1);
  assert.ok(near(st.spent, 1.5) && near(st.planned, 1));

  // mécanicien désactivé : il reste dans les statistiques des périodes où il a travaillé
  assert.equal((await A('PUT', `/users/${m.id}`, { active: false })).status, 200);
  st = await statsOf(m.id);
  assert.ok(st && st.inactive === true && st.overruns === 1, JSON.stringify(st));

  // intervention sur deux jours : chacun la compte le jour de SON dernier pointage, avec le temps total de l'intervention
  const a = await mechanic('Ana2');
  const b = await mechanic('Bruno2');
  const o = await order([{ kind: 'labor', description: 'Distribution', quantity: 2, unit_price: 80, tax_rate: 17 }]);
  await K(b.tok, { action: 'start', document_id: o.id, line_id: o.lines[0].id });
  const eb = await backdate(b.id, 30);
  await A('PUT', `/timesheets/${eb.id}`, { start: local(ago(30)), end: local(ago(29)) }); // hier : 1 h
  await K(a.tok, { action: 'start', document_id: o.id, line_id: o.lines[0].id });
  await backdate(a.id, 2); // aujourd'hui : 2 h, puis terminé
  await call('POST', `/kiosk/orders/${o.id}`, { line_id: o.lines[0].id, done: true }, a.tok);
  const todayOnly = `from=${day(ago(2))}&to=${day(new Date())}`;
  if (day(ago(30)) < day(ago(2))) { // (sauf si le test tourne juste après minuit)
    const sa = await statsOf(a.id, todayOnly), sb = await statsOf(b.id, todayOnly);
    assert.equal(sa.interventions, 1);
    assert.ok(near(sa.planned, 2 * (2 / 3), 0.03) && near(sa.spent, 2), JSON.stringify(sa));
    assert.equal(sb.interventions, 0, 'Bruno n\'a pas travaillé aujourd\'hui : rien ne lui est compté aujourd\'hui');
    const yesterday = `from=${day(ago(30))}&to=${day(ago(30))}`;
    const yb = await statsOf(b.id, yesterday);
    assert.equal(yb.interventions, 1);
    assert.ok(near(yb.planned, 2 * (1 / 3), 0.03) && near(yb.spent, 1), JSON.stringify(yb));
    assert.equal(yb.overruns, 0, 'le dépassement est compté à celle qui a fait l\'essentiel');
    const list = (await A('GET', `/timesheets/stats?${yesterday}`)).data.interventions.find((x) => x.document_id === o.id);
    assert.ok(list && near(list.spent, 3) && near(list.period_spent, 1), JSON.stringify(list));
  }
});
