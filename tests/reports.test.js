// Rapports mensuels de l'atelier : chaque mécanicien reçoit le sien, le gérant celui de toute l'équipe.
// Le test démarre un vrai serveur sur une base vide (e-mails « envoyés » dans le vide) et passe par l'API.
process.env.TZ ||= 'Europe/Luxembourg';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4600 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-reports-'));
// Les modules importés directement par ce fichier travaillent sur une base temporaire à part
const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-reports-unit-'));
process.env.DATA_DIR = unitDir;
process.env.MAIL_TRANSPORT = 'json';
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
const MONTH = local(new Date()).slice(0, 7);
const near = (a, b, tol = 0.03) => Math.abs(a - b) <= tol;

async function mechanic(name, email) {
  const r = await A('POST', '/users', { name, role: 'mechanic', pin: '4321', email: email || null, invite: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.invite, null, 'un mécanicien avec une adresse ne reçoit jamais d\'invitation à se connecter');
  const tok = (await call('POST', '/kiosk/login', { user_id: r.data.id })).data.token;
  return { id: r.data.id, tok };
}
/** Une intervention chronométrée : « hours » de travail qui se terminent maintenant (dans le mois en cours). */
async function work(m, lineOf, hours, done = true) {
  await call('POST', '/kiosk/clock', { action: 'start', document_id: lineOf.doc, line_id: lineOf.line }, m.tok);
  const today = local(new Date()).slice(0, 10);
  const e = (await A('GET', `/timesheets?from=${today}&to=${today}`)).data.entries.find((x) => x.user_id === m.id && x.kind === 'work' && !x.end);
  // début reculé sans sortir de la journée (le test peut tourner juste après minuit)
  const start = new Date(Math.max(Date.now() - hours * 3600000, new Date(`${today}T00:00:01`).getTime()));
  assert.equal((await A('PUT', `/timesheets/${e.id}`, { start: local(start) })).status, 200);
  if (done) await call('POST', `/kiosk/orders/${lineOf.doc}`, { line_id: lineOf.line, done: true }, m.tok);
  else await call('POST', '/kiosk/clock', { action: 'stop' }, m.tok);
  return (Date.now() - start.getTime()) / 3600000;
}

before(async () => {
  let out = '';
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', PUBLIC_URL: '', MAIL_TRANSPORT: 'json' }, stdio: 'pipe' });
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 80 && !/démarré/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  const s = await call('POST', '/auth/setup', { name: 'Gérant', email: 'gerant@t.lu', password: 'secret123', company: 'Garage Test' });
  assert.equal(s.status, 200, out);
  admin = s.data.token;
  await A('PUT', '/settings', { attendance: { kiosk_pin: false } });
  customer = (await A('POST', '/customers', { name: 'Client atelier' })).data.id;
});
after(() => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(unitDir, { recursive: true, force: true }); });

test('rapport du mois : une fiche par mécanicien, totaux de l\'équipe, dépassements', async () => {
  const paulo = await mechanic('Paulo Silva', 'paulo@t.lu');
  const kevin = await mechanic('Kevin', null); // pas d'adresse e-mail
  const or = (await A('POST', '/documents', { type: 'order', customer_id: customer, lines: [
    { kind: 'labor', description: 'Vidange', quantity: 1, unit_price: 80, tax_rate: 17 },
    { kind: 'labor', description: 'Plaquettes <AV>', quantity: 1, unit_price: 80, tax_rate: 17 },
    { kind: 'labor', description: 'Géométrie', quantity: 2, unit_price: 80, tax_rate: 17 },
  ] })).data.id;
  const lines = (await A('GET', `/documents/${or}`)).data.lines;
  const h1 = await work(paulo, { doc: or, line: lines[0].id }, 0.5);  // 0h30 pour 1h : dans le temps
  const h2 = await work(paulo, { doc: or, line: lines[1].id }, 1.5);  // 1h30 pour 1h : dépassement (si la journée a commencé depuis assez longtemps)
  const h3 = await work(kevin, { doc: or, line: lines[2].id }, 1);    // 1h pour 2h

  const rep = (await A('GET', `/timesheets/report?month=${MONTH}`)).data;
  assert.equal(rep.month, MONTH);
  assert.equal(rep.complete, false, 'mois en cours');
  const p = rep.mechanics.find((m) => m.id === paulo.id), k = rep.mechanics.find((m) => m.id === kevin.id);
  assert.equal(p.interventions, 2);
  assert.ok(near(p.planned, 2) && near(p.spent, h1 + h2) && near(p.work, h1 + h2), JSON.stringify(p));
  assert.equal(p.overruns, h2 > 1.01 ? 1 : 0);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows.map((r) => r.description).sort(), ['Plaquettes <AV>', 'Vidange']);
  assert.ok(p.rows.every((r) => r.number && r.planned === 1 && r.document_id === or));
  assert.equal(p.days, 1, 'un jour de présence (créée par le premier chrono)');
  assert.equal(k.interventions, 1);
  assert.ok(near(k.planned, 2) && near(k.spent, h3));
  assert.ok(near(rep.totals.planned, 4) && near(rep.totals.spent, h1 + h2 + h3) && rep.totals.interventions === 3, JSON.stringify(rep.totals));
  assert.equal(rep.overruns.length, h2 > 1.01 ? 1 : 0);

  // mois invalide, mois pas encore commencé
  assert.equal((await A('GET', '/timesheets/report?month=2026-13')).status, 400);
  assert.equal((await A('GET', '/timesheets/report?month=abc')).status, 400);
  const next = new Date(); next.setDate(1); next.setMonth(next.getMonth() + 2);
  assert.equal((await A('GET', `/timesheets/report?month=${local(next).slice(0, 7)}`)).status, 400);
});

test('envoi : chacun reçoit le sien, le gérant celui de l\'équipe, rien n\'est envoyé deux fois', async () => {
  const plan = (await A('GET', `/timesheets/report/plan?month=${MONTH}`)).data;
  assert.equal(plan.mail_configured, true);
  const pp = plan.mechanics.find((m) => m.name === 'Paulo Silva'), pk = plan.mechanics.find((m) => m.name === 'Kevin');
  assert.equal(pp.email, 'paulo@t.lu');
  assert.equal(pk.email, null);
  assert.deepEqual(plan.team.map((t) => t.email), ['gerant@t.lu']);
  assert.equal(pp.last, null);

  const r = (await A('POST', '/timesheets/report/send', { month: MONTH })).data;
  const by = (name) => r.delivery.find((d) => d.name === name);
  assert.equal(by('Paulo Silva').status, 'sent');
  assert.equal(by('Paulo Silva').to, 'paulo@t.lu');
  assert.equal(by('Kevin').status, 'no_email');
  assert.equal(by('Gérant').status, 'sent');
  assert.equal(r.sent, 2);

  // boîte d'envoi : chaque rapport va à son destinataire — celui de Paulo ne parle que de Paulo
  const box = (await A('GET', '/mail/outbox')).data.filter((e) => /rapport/i.test(e.subject));
  const mine = box.find((e) => e.to_addr === 'paulo@t.lu'), team = box.find((e) => e.to_addr === 'gerant@t.lu');
  assert.ok(/Votre rapport d'activité/.test(mine.subject) && mine.status === 'sent');
  assert.ok(/Rapport de l'atelier/.test(team.subject) && team.status === 'sent');
  assert.ok(/Bonjour Paulo/.test(mine.intro));
  // un collègue du bureau (droit E-mails, pas administrateur) ne voit pas ces e-mails
  await A('POST', '/users', { name: 'Bureau', email: 'bureau@t.lu', role: 'office', password: 'secret123', permissions: { emails: 'user', presences: 'read' } });
  const office = (await call('POST', '/auth/login', { email: 'bureau@t.lu', password: 'secret123' })).data.token;
  assert.equal((await call('GET', '/mail/outbox', undefined, office)).data.filter((e) => /rapport/i.test(e.subject)).length, 0);
  // … peut lire le rapport (droit Présences en lecture), mais pas l'envoyer
  assert.equal((await call('GET', `/timesheets/report?month=${MONTH}`, undefined, office)).status, 200);
  assert.equal((await call('POST', '/timesheets/report/send', { month: MONTH }, office)).status, 403);
  assert.equal((await call('GET', `/timesheets/report/plan?month=${MONTH}`, undefined, office)).status, 403);
  await A('POST', '/users', { name: 'Ventes', email: 'ventes@t.lu', role: 'office', password: 'secret123', permissions: { ventes: 'user' } });
  const sales = (await call('POST', '/auth/login', { email: 'ventes@t.lu', password: 'secret123' })).data.token;
  assert.equal((await call('GET', `/timesheets/report?month=${MONTH}`, undefined, sales)).status, 403, 'sans le droit Présences : pas de rapport');

  // second envoi : rien ne repart (sauf si on le demande)
  const again = (await A('POST', '/timesheets/report/send', { month: MONTH })).data;
  assert.equal(again.sent, 0);
  assert.equal(again.delivery.find((d) => d.name === 'Paulo Silva').status, 'already');
  const forced = (await A('POST', '/timesheets/report/send', { month: MONTH, force: true, only: { mechanic: plan.mechanics.find((m) => m.name === 'Paulo Silva').id } })).data;
  assert.equal(forced.sent, 1);
  assert.equal(forced.delivery.length, 1, 'un seul destinataire demandé');
  assert.equal((await A('POST', '/timesheets/report/send', { month: MONTH, only: { mechanic: 'x' } })).status, 400);
  assert.equal((await A('POST', '/timesheets/report/send', { month: 'nope' })).status, 400);
  const after = (await A('GET', `/timesheets/report/plan?month=${MONTH}`)).data;
  assert.equal(after.mechanics.find((m) => m.name === 'Paulo Silva').last.status, 'sent');

  // adresse supplémentaire pour le rapport d'équipe (comptable, associé) ; une adresse mal écrite est refusée, avec un message
  const wrong = await A('PUT', '/settings', { options: { atelier: { monthly_report: true, report_to: 'compta@t.lu, pas-une-adresse' } } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /pas-une-adresse/);
  const s = (await A('PUT', '/settings', { options: { atelier: { monthly_report: true, monthly_report_time: '99:99', report_to: 'compta@t.lu' } } })).data;
  assert.deepEqual(s.options.atelier, { monthly_report: true, monthly_report_time: '07:00', report_to: 'compta@t.lu' });
  const teamOnly = (await A('POST', '/timesheets/report/send', { month: MONTH, only: { team: true } })).data;
  assert.deepEqual(teamOnly.delivery.map((d) => [d.to, d.status]), [['gerant@t.lu', 'already'], ['compta@t.lu', 'sent']]);
});

test('mise en page et envoi automatique de début de mois', async () => {
  const R = await import('../src/reports.js');
  // textes saisis par le garage : toujours échappés dans l'e-mail
  const rep = { label: 'octobre 2026', from: '2026-10-01', to: '2026-10-31', mechanics: [], totals: {}, overruns: [], to_check: [] };
  const m = { name: 'Paulo <b>', days: 20, presence: 160, work: 120.5, productivity: 75, interventions: 2, planned: 3, spent: 3.5, gap: 0.5, overruns: 1, to_check: 1,
    rows: [{ date: '2026-10-05', number: 'OR2026-0007', plate: 'AB 1234', description: 'Plaquettes <script>alert(1)</script>', planned: 1, spent: 1.5, gap: 0.5, state: 'over', with: 'Kevin & co' }] };
  const html = R.mechanicHtml(rep, m);
  assert.ok(!/<script>/.test(html) && /&lt;script&gt;/.test(html), 'texte échappé');
  assert.ok(/Paulo &lt;b&gt;/.test(html));
  assert.ok(/120h30/.test(html) && /1h30/.test(html) && /\+ 0h30/.test(html), 'heures lisibles (1h30), écart signé');
  assert.ok(/à vérifier/.test(html) && /avec Kevin &amp; co/.test(html));
  const team = R.teamHtml({ ...rep, mechanics: [m], totals: { presence: 160, work: 120.5, productivity: 75, interventions: 2, planned: 3, spent: 3.5, gap: 0.5, overruns: 1 },
    overruns: [{ description: 'Plaquettes', number: 'OR2026-0007', plate: 'AB 1234', mechanics: 'Paulo', planned: 1, spent: 1.5, over: 0.5 }], to_check: [] },
  [{ name: 'Paulo', status: 'sent' }, { name: 'Kevin', status: 'no_email' }]);
  assert.ok(/Total équipe/.test(team) && /Interventions en dépassement/.test(team) && /Pas d'adresse e-mail[^<]*Kevin/.test(team));
  assert.equal(R.previousMonth(new Date(2026, 0, 3)), '2025-12');
  assert.throws(() => R.monthBounds('2026-00'));

  // envoi automatique : le 1er du mois (ou les jours suivants jusqu'au 10) à partir de l'heure choisie, une seule fois
  const opts = { monthly_report: true, monthly_report_time: '07:00', report_to: '' };
  const first = new Date(); first.setDate(1); first.setHours(7, 5, 0, 0);
  const early = new Date(first); early.setHours(6, 59);
  const late = new Date(first); late.setDate(11);
  assert.equal(await R.runMonthlyReports({ ...opts, monthly_report: false }, first), null, 'option désactivée');
  assert.equal(await R.runMonthlyReports(opts, early), null, 'avant l\'heure');
  assert.equal(await R.runMonthlyReports(opts, late), null, 'après le 10 : on n\'envoie plus un vieux rapport par surprise');
  const run = await R.runMonthlyReports(opts, first);
  assert.equal(run.month, R.previousMonth(first));
  assert.equal(await R.runMonthlyReports(opts, first), null, 'une seule fois par mois');

  const D = await import('../src/db.js');
  const prev = R.previousMonth(first);
  const to = (r, addr) => r.delivery.find((d) => d.to === addr)?.status;
  // un envoi fait AVANT la fin du mois (essai en cours de mois) n'empêche pas le rapport complet de partir ensuite
  D.run("INSERT INTO report_runs(month, kind, user_id, to_addr, status, auto, sent_at) VALUES(?, 'team', NULL, 'associe@t.lu', 'sent', 0, ?)", prev, `${prev}-15T10:00:00`);
  assert.equal(R.reportPlan(prev, 'associe@t.lu').team.find((r) => r.email === 'associe@t.lu').last.partial, true, 'signalé comme « mois incomplet »');
  const only = { only: { team: true }, extra: 'associe@t.lu' };
  assert.equal(to(await R.sendMonthlyReports(prev, only), 'associe@t.lu'), 'sent', 'le rapport du mois complet part');
  assert.equal(to(await R.sendMonthlyReports(prev, only), 'associe@t.lu'), 'already', 'mais pas deux fois');
  // deux demandes au même moment : une seule est exécutée
  const both = await Promise.allSettled([R.sendMonthlyReports(prev, { ...only, force: true }), R.sendMonthlyReports(prev, { ...only, force: true })]);
  assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(both.find((r) => r.status === 'rejected').reason.message, /déjà en cours/);
  // envoi automatique en échec : nouvel essai une heure plus tard (pas avant), ce qui est déjà parti ne repart pas
  D.run("UPDATE report_runs SET status='partial', error='1 envoi(s) en échec' WHERE month=? AND kind='auto'", prev);
  assert.equal(await R.runMonthlyReports(opts, new Date(first.getTime() + 30 * 60000)), null, 'pas de nouvel essai avant une heure');
  const retry = await R.runMonthlyReports(opts, new Date(first.getTime() + 61 * 60000));
  assert.equal(retry?.month, prev, 'nouvel essai après une heure');
  assert.equal(retry.sent, 0, 'rien n\'est renvoyé à ceux qui ont déjà reçu leur rapport');
  assert.equal(D.get("SELECT status FROM report_runs WHERE month=? AND kind='auto'", prev).status, 'done');
  assert.equal(await R.runMonthlyReports(opts, new Date(first.getTime() + 200 * 60000)), null, 'terminé : plus d\'essai');

  // une intervention non jugée (en cours, chrono oublié) n'affiche pas d'écart dans le rapport
  const html2 = R.mechanicHtml(rep, { ...m, rows: [{ date: '2026-10-06', number: 'OR2026-0008', description: 'Embrayage', planned: 3, spent: 1, gap: null, state: 'open', with: '' }] });
  assert.ok(/en cours/.test(html2) && !/− 2h00/.test(html2));
});
