// Droits d'accès par application, invitations, présences et options de configuration (façon Odoo).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-acl-'));
let db, A, P, O, B;
let admin, office, mech;
before(async () => {
  Object.assign(process.env, { DATA_DIR: dataDir, MAIL_TRANSPORT: 'json' });
  db = await import('../src/db.js');
  await import('../src/live.js');
  await import('../src/bills.js');
  A = await import('../src/access.js');
  P = await import('../src/attendance.js');
  O = await import('../src/automation.js');
  B = await import('../src/business.js');
  admin = db.insert('users', { name: 'Gérant', email: 'g@g.lu', role: 'admin' }, ['name', 'email', 'role']);
  office = db.insert('users', { name: 'Marc', email: 'm@g.lu', role: 'office', permissions: JSON.stringify(A.PRESETS.magasinier.perms) }, ['name', 'email', 'role', 'permissions']);
  mech = db.insert('users', { name: 'Paulo', role: 'mechanic' }, ['name', 'role']);
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const user = (id) => db.get('SELECT id, role, permissions FROM users WHERE id=?', id);
const req = (method, p, extra = {}) => ({ method, path: p, query: {}, body: {}, ...extra });
const guard = (u, r) => { let code = 200, body; A.accessGuard({ ...r, user: u }, { status: (c) => ({ json: (b) => { code = c; body = b; } }) }, () => {}); return { code, body }; };

test('droits : modèles, droits induits et gérant', () => {
  const m = user(office);
  assert.equal(A.can(m, 'inventaire', 'manager'), true);
  assert.equal(A.can(m, 'ventes'), false);
  assert.equal(A.can(m, 'contacts', 'read'), true); // induit par Achats (utilisateur)
  assert.equal(A.can(m, 'contacts', 'user'), false);
  assert.equal(A.can(user(admin), 'comptabilite', 'manager'), true);
  assert.equal(A.can(user(mech), 'atelier'), false);
  assert.deepEqual(Object.keys(A.normalizePerms('{"ventes":"hack","atelier":"user"}')).length, A.APPS.length);
  assert.equal(A.normalizePerms('{"ventes":"hack"}').ventes, 'none');
});

test('garde des routes : lecture, écriture, suppression et documents par type', () => {
  const m = user(office);
  assert.equal(guard(m, req('GET', '/products')).code, 200);
  assert.equal(guard(m, req('DELETE', '/products/1')).code, 200); // administrateur de l'inventaire
  assert.equal(guard(m, req('POST', '/customers')).code, 403);
  assert.match(guard(m, req('GET', '/accounting/balance')).body.error, /Comptabilité/);
  const cust = db.insert('customers', { name: 'Client' }, ['name']);
  const order = db.insert('documents', { type: 'order', customer_id: cust }, ['type', 'customer_id']);
  const inv = db.insert('documents', { type: 'invoice', customer_id: cust }, ['type', 'customer_id']);
  assert.equal(guard(m, req('GET', `/documents/${order}`)).code, 200); // atelier : lecture
  assert.equal(guard(m, req('PUT', `/documents/${order}`)).code, 403);
  assert.equal(guard(m, req('GET', `/documents/${inv}`)).code, 403); // ventes : aucun accès
  assert.equal(guard(m, req('GET', '/documents', { query: { type: 'invoice' } })).code, 403);
  assert.equal(guard(m, req('POST', '/attendance/check')).code, 200); // son propre pointage : toujours permis
  assert.equal(guard(m, req('GET', '/dashboard')).code, 200);
  // Une session kiosque ne sort pas du kiosque, même pour le gérant
  assert.equal(guard({ ...user(admin), session_kind: 'kiosk' }, req('GET', '/settings')).code, 403);
});

test('invitation : lien valable, à usage unique', () => {
  const { token } = A.createInvite(office);
  assert.equal(A.findInvite(token).id, office);
  assert.equal(A.findInvite('0'.repeat(48)), null);
  assert.equal(A.findInvite('abc'), null);
  A.clearInvite(office);
  assert.equal(A.findInvite(token), null);
  const t2 = A.createInvite(office).token;
  db.run("UPDATE users SET invite_expires='2000-01-01T00:00:00Z' WHERE id=?", office);
  assert.equal(A.findInvite(t2), null); // expirée
});

test('présences : arrivée, départ, rapport et départ automatique', () => {
  const r1 = P.checkInOut(mech);
  assert.equal(r1.action, 'in');
  assert.equal(P.statusOf(mech).present, true);
  assert.ok(P.board().find((u) => u.id === mech).present);
  const r2 = P.checkInOut(mech);
  assert.equal(r2.action, 'out');
  assert.throws(() => P.checkInOut(mech, { action: 'out' }), /pas pointé/);
  // Correction manuelle et rapport
  const id = P.saveAttendance({ user_id: mech, start: '2026-03-02T08:00', end: '2026-03-02T17:30' });
  assert.throws(() => P.saveAttendance({ user_id: mech, start: '2026-03-02T10:00', end: '2026-03-02T09:00' }), /après/);
  const rep = P.attendanceReport({ from: '2026-03-02', to: '2026-03-06' }).find((r) => r.user_id === mech);
  assert.equal(rep.worked, 9.5);
  assert.equal(rep.expected, 40);
  assert.equal(rep.overtime, -30.5);
  assert.equal(P.listAttendance({ from: '2026-03-02', to: '2026-03-02' })[0].id, id);
  // Pointage oublié hier : fermé automatiquement après les heures prévues
  db.insert('time_entries', { user_id: office, kind: 'presence', start: '2026-03-03T08:00:00' }, ['user_id', 'kind', 'start']);
  assert.equal(P.autoCheckout(), 1);
  const e = db.get("SELECT * FROM time_entries WHERE user_id=? AND start='2026-03-03T08:00:00'", office);
  assert.equal(e.end, '2026-03-03T16:00:00');
  assert.match(e.note, /automatique/);
});

test('options : nettoyage, verrouillage comptable, stock négatif, relances', async () => {
  const o = O.cleanOptions({ ventes: { quote_validity_days: '45', line_discounts: 0 }, comptabilite: { lock_date: 'n\'importe quoi', vat_period: 'xx' }, relances: { levels: [{ days: 30, name: 'B' }, { days: 5, name: 'A', action: 'bad' }] }, inconnu: { x: 1 } });
  assert.equal(o.ventes.quote_validity_days, 45);
  assert.equal(o.ventes.line_discounts, false);
  assert.equal(o.comptabilite.lock_date, '');
  assert.equal(o.comptabilite.vat_period, 'quarter');
  assert.deepEqual(o.relances.levels.map((l) => [l.days, l.action]), [[5, 'email'], [30, 'email']]);
  assert.equal(o.inconnu, undefined);

  db.setSetting('options', { ...O.options(), comptabilite: { ...O.options().comptabilite, lock_date: '2026-03-31' } });
  assert.throws(() => B.createMove({ journal_code: 'OD', date: '2026-03-15', ref: 'x' }, [{ account_code: '6070', debit: 10 }, { account_code: '5131', credit: 10 }]), /Période clôturée/);

  const prod = db.insert('products', { ref: 'P1', name: 'Filtre', qty_on_hand: 1 }, ['ref', 'name', 'qty_on_hand']);
  db.setSetting('options', { ...O.options(), inventaire: { allow_negative: false } });
  assert.throws(() => B.addStockMove({ product_id: prod, qty: -2, kind: 'sale' }), /Stock insuffisant/);
  B.addStockMove({ product_id: prod, qty: -1, kind: 'sale' });

  // Relances : facture en retard de 20 jours → niveau 2 (15 j), une seule fois
  const cust = db.insert('customers', { name: 'Retard SA' }, ['name']);
  const due = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
  const inv = db.insert('documents', { type: 'invoice', number: 'F-R1', status: 'posted', customer_id: cust, date: due, due_date: due, total: 100, amount_paid: 0 },
    ['type', 'number', 'status', 'customer_id', 'date', 'due_date', 'total', 'amount_paid']);
  db.setSetting('options', { ...O.options(), relances: { ...O.options().relances, enabled: true } });
  const r = await O.runFollowups();
  assert.deepEqual(r.done.map((d) => [d.number, d.level, d.action]), [['F-R1', 2, 'activity']]);
  assert.ok(db.get("SELECT * FROM activities WHERE record_id=? AND summary LIKE 'Relance : F-R1%'", inv));
  assert.equal((await O.runFollowups()).done.length, 0);
});
