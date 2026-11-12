// Corrections issues de l'audit : droits d'accès, présences, calculs, banque, e-mails.
// Le test démarre un vrai serveur sur une base vide et passe par l'API, comme le navigateur.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-audit-'));
let server, admin;

async function call(method, url, body, tok, headers = {}) {
  const raw = Buffer.isBuffer(body) || typeof body === 'string';
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const A = (method, url, body, headers) => call(method, url, body, admin, headers);
/** Crée un utilisateur de bureau avec les droits donnés et renvoie son jeton. */
async function userWith(perms, name = 'U' + Math.random().toString(36).slice(2, 8)) {
  const email = `${name.toLowerCase()}@t.lu`;
  const r = await A('POST', '/users', { name, email, role: 'office', password: 'secret123', permissions: perms });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const l = await call('POST', '/auth/login', { email, password: 'secret123' });
  return { id: r.data.id, tok: l.data.token };
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

test('droits : une majuscule dans l\'adresse ne contourne plus les droits', async () => {
  const zero = await userWith({});
  assert.equal((await call('GET', '/customers', undefined, zero.tok)).status, 403);
  for (const p of ['/Customers', '/CUSTOMERS', '/Accounting/balance', '/Documents', '/Bank/lines']) {
    const r = await call('GET', p, undefined, zero.tok);
    assert.ok([403, 404].includes(r.status), `${p} → ${r.status}`);
  }
  assert.ok([403, 404].includes((await call('POST', '/Customers', { name: 'Pirate' }, zero.tok)).status));
  assert.equal((await A('GET', '/customers')).data.some((c) => c.name === 'Pirate'), false);
});

test('droits : pièces jointes, historique, activités et e-mails suivent le droit sur la fiche', async () => {
  const cust = (await A('POST', '/customers', { name: 'Jean Muller', email: 'jean@t.lu' })).data.id;
  const inv = (await A('POST', '/documents', { type: 'invoice', customer_id: cust, lines: [{ kind: 'part', description: 'Filtre', quantity: 1, unit_price: 100, vat_rate: 17 }] })).data.id;
  const att = (await A('POST', `/attachments/customer/${cust}`, Buffer.from('bonjour'), { 'Content-Type': 'application/pdf', 'X-Filename': 'note.pdf' })).data.id;
  const act = (await A('POST', '/activities', { model: 'customer', record_id: cust, summary: 'Rappeler', due_date: '2030-01-01' })).data.id;
  const zero = await userWith({ inventaire: 'user' });
  assert.equal((await call('GET', `/attachments/customer/${cust}`, undefined, zero.tok)).status, 403);
  assert.equal((await call('GET', `/attachment/${att}`, undefined, zero.tok)).status, 403);
  assert.equal((await call('DELETE', `/attachment/${att}`, undefined, zero.tok)).status, 403);
  assert.equal((await call('GET', `/chatter/customer/${cust}`, undefined, zero.tok)).status, 403);
  assert.equal((await call('POST', `/chatter/document/${inv}/note`, { body: 'x' }, zero.tok)).status, 403);
  assert.equal((await call('POST', '/activities', { model: 'customer', record_id: cust, summary: 'x', due_date: '2030-01-01' }, zero.tok)).status, 403);
  assert.equal((await call('POST', `/activities/${act}/done`, {}, zero.tok)).status, 403, 'activité d\'un autre');
  assert.equal((await call('DELETE', `/activities/${act}`, undefined, zero.tok)).status, 403);
  const mine = await call('GET', '/activities', undefined, zero.tok);
  assert.equal(mine.status, 200);
  assert.equal(mine.data.find((a) => a.id === act).record, null, 'la fiche liée est masquée');
  assert.equal((await call('GET', `/mail/compose?model=document&id=${inv}`, undefined, zero.tok)).status, 403);
  assert.equal((await call('POST', '/mail/preview', { model: 'document', record_id: inv, include_document: true }, zero.tok)).status, 403);
  // … mais restent ouverts à qui a le droit sur la fiche
  const ok = await userWith({ contacts: 'user', ventes: 'read' });
  assert.equal((await call('GET', `/attachments/customer/${cust}`, undefined, ok.tok)).status, 200);
  assert.equal((await call('GET', `/chatter/document/${inv}`, undefined, ok.tok)).status, 200);
  assert.equal((await call('GET', `/mail/compose?model=document&id=${inv}`, undefined, ok.tok)).status, 200);
  assert.equal((await call('DELETE', `/attachment/${att}`, undefined, ok.tok)).status, 200, 'retirer une pièce jointe : niveau Utilisateur');
  // Activités et plan comptable pour les profils sans « E-mails » ni « Comptabilité »
  const mag = await userWith({ inventaire: 'manager', achats: 'user' });
  assert.equal((await call('GET', '/mail/config', undefined, mag.tok)).status, 200);
  assert.equal((await call('GET', '/accounting/accounts', undefined, mag.tok)).status, 200);
  assert.equal((await call('GET', '/accounting/balance', undefined, mag.tok)).status, 403);
  const users = (await call('GET', '/users', undefined, mag.tok)).data;
  assert.equal('hourly_cost' in users[0] || 'email' in users[0], false, 'coût horaire et e-mails réservés');
  assert.equal((await call('GET', '/odoo', undefined, mag.tok)).status, 403);
});

test('droits : documents filtrés par type, corrections de pointage réservées', async () => {
  const cust = (await A('POST', '/customers', { name: 'Anna' })).data.id;
  await A('POST', '/documents', { type: 'order', customer_id: cust, lines: [] });
  await A('POST', '/documents', { type: 'quote', customer_id: cust, lines: [] });
  const ventes = await userWith({ ventes: 'read' });
  const list = await call('GET', '/documents', undefined, ventes.tok);
  assert.equal(list.status, 200);
  assert.equal(list.data.some((d) => d.type === 'order'), false, 'pas d\'OR sans le droit Atelier');
  assert.equal((await call('GET', '/documents?type=quote,order', undefined, ventes.tok)).status, 403);
  assert.equal((await call('GET', '/documents?type=order&type=quote', undefined, ventes.tok)).status, 403);
  const atelier = await userWith({ atelier: 'user' });
  assert.equal((await call('POST', '/documents?type=order', { type: 'invoice', customer_id: cust, lines: [] }, atelier.tok)).status, 403, 'le type vient du corps de la requête');
  // Pointages
  const pres = await userWith({ presences: 'user' });
  const id = (await A('POST', '/attendance', { user_id: pres.id, start: '2026-03-02T08:00', end: '2026-03-02T16:00' })).data.id;
  assert.equal((await call('PUT', `/timesheets/${id}`, { start: '2026-03-02T05:00:00' }, pres.tok)).status, 403);
  assert.equal((await A('PUT', `/timesheets/${id}`, { start: 'n importe quoi' })).status, 400);
  assert.equal((await A('POST', '/attendance', { user_id: pres.id, start: '2026-03-02T09:00', end: '2026-03-02T10:00' })).status, 400, 'chevauchement refusé');
  // Rapport : une période absurde ne bloque plus le serveur
  const t0 = Date.now();
  assert.equal((await A('GET', '/attendance/report?from=2026-01-01&to=9999-12-31')).status, 400);
  assert.equal((await A('GET', '/attendance/report?from=2026-01-01&to=pasunedate')).status, 400);
  assert.ok(Date.now() - t0 < 2000);
  const rep = await A('GET', '/attendance/report?from=2026-03-02&to=2026-03-08');
  assert.equal(rep.data.find((r) => r.user_id === pres.id).worked, 8);
});

test('calculs : arrondi au demi-centime, mêmes totaux partout', async () => {
  const cust = (await A('POST', '/customers', { name: 'Arrondi' })).data.id;
  // 1,50 € à 17 % = 0,255 € de TVA → 0,26 € (et non 0,25) ; 1 × 1,005 = 1,01
  const id = (await A('POST', '/documents', { type: 'invoice', customer_id: cust, lines: [
    { kind: 'part', description: 'A', quantity: 1, unit_price: 1.5, tax_rate: 17 },
    { kind: 'part', description: 'B', quantity: 1, unit_price: 1.005, tax_rate: 0 },
    { kind: 'part', description: 'sans quantité', unit_price: 10, tax_rate: 3 },
  ] })).data.id;
  const d = (await A('GET', `/documents/${id}`)).data;
  assert.equal(d.taxes.find((t) => t.rate === 17).amount, 0.26);
  assert.equal(d.lines[1].total_ht, 1.01);
  assert.equal(d.lines[2].quantity, 1);
  assert.equal(d.lines[2].total_ht, 10, 'quantité par défaut prise en compte dans le total de la ligne');
  assert.equal(d.subtotal, 12.51);
  assert.equal(d.total, 13.07);
  assert.equal((await A('POST', `/documents/${id}/post`)).status, 200, 'écriture équilibrée');
  // Le calcul de l'écran (public/js/totals.js) donne exactement le même résultat que le serveur
  const { computeTotals } = await import('../public/js/totals.js');
  const t = computeTotals(d.lines);
  assert.deepEqual([t.sub, t.tax, t.total], [d.subtotal, d.tax_total, d.total]);
  // Remise et dates contrôlées
  assert.equal((await A('POST', '/documents', { type: 'quote', customer_id: cust, lines: [{ kind: 'part', description: 'x', quantity: 1, unit_price: 10, discount: 150 }] })).status, 400);
  assert.equal((await A('POST', '/documents', { type: 'invoice', customer_id: cust, date: 'garbage', lines: [] })).status, 400);
  assert.equal((await A('POST', `/documents/${id}/payments`, { amount: 1, date: 'hello' })).status, 400);
});

test('facturation : une seule facture par OR, avoirs plafonnés, paiements plafonnés', async () => {
  const cust = (await A('POST', '/customers', { name: 'Double', payment_terms: 45 })).data.id;
  const line = { kind: 'labor', description: 'Main-d\'œuvre', quantity: 2, unit_price: 50, tax_rate: 17 };
  const or = (await A('POST', '/documents', { type: 'order', customer_id: cust, lines: [line] })).data.id;
  // Double clic sur « Facturer » : les deux requêtes partent en même temps
  const [a, b] = await Promise.all([A('POST', `/documents/${or}/convert`, { type: 'invoice' }), A('POST', `/documents/${or}/convert`, { type: 'invoice' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400], 'une seule facture créée');
  const inv = (a.status === 200 ? a : b).data.id;
  const invoice = (await A('GET', `/documents/${inv}`)).data;
  const days = Math.round((new Date(invoice.due_date) - new Date(invoice.date)) / 864e5);
  assert.equal(days, 45, 'délai de paiement du client repris à la conversion');
  // Supprimer la facture brouillon libère l'OR
  assert.equal((await A('GET', `/documents/${or}`)).data.status, 'invoiced');
  assert.equal((await A('DELETE', `/documents/${inv}`)).status, 200);
  assert.equal((await A('GET', `/documents/${or}`)).data.status, 'done');
  const inv2 = (await A('POST', `/documents/${or}/convert`, { type: 'invoice' })).data.id;
  // Le statut ne se force pas par l'enregistrement
  await A('PUT', `/documents/${inv2}`, { status: 'paid' });
  assert.equal((await A('GET', `/documents/${inv2}`)).data.status, 'draft');
  assert.equal((await A('POST', `/documents/${inv2}/post`)).status, 200);
  // Paiements : pas plus que le reste dû (117 €)
  assert.equal((await A('POST', `/documents/${inv2}/payments`, { amount: 200 })).status, 400);
  assert.equal((await A('POST', `/documents/${inv2}/payments`, { amount: 17 })).status, 200);
  // Avoirs : un seul brouillon à la fois, jamais plus que la facture
  const cn = await A('POST', `/documents/${inv2}/convert`, { type: 'credit_note' });
  assert.equal(cn.status, 200);
  assert.equal((await A('POST', `/documents/${inv2}/convert`, { type: 'credit_note' })).status, 400, 'un avoir en brouillon existe déjà');
  assert.equal((await A('POST', `/documents/${cn.data.id}/post`)).status, 200);
  assert.equal((await A('POST', `/documents/${inv2}/convert`, { type: 'credit_note' })).status, 400, 'facture entièrement créditée');
  // Facture à 0 € : soldée tout de suite
  const free = (await A('POST', '/documents', { type: 'invoice', customer_id: cust, lines: [{ ...line, discount: 100 }] })).data.id;
  assert.equal((await A('POST', `/documents/${free}/post`)).status, 200);
  assert.equal((await A('GET', `/documents/${free}`)).data.status, 'paid');
});

test('atelier : le bureau n\'écrase plus les saisies du mécanicien', async () => {
  const cust = (await A('POST', '/customers', { name: 'Atelier' })).data.id;
  const mech = (await A('POST', '/users', { name: 'Paulo', role: 'mechanic', pin: '4321' })).data.id;
  const or = (await A('POST', '/documents', { type: 'order', customer_id: cust, lines: [{ kind: 'labor', description: 'Vidange', quantity: 1, unit_price: 80, tax_rate: 17 }] })).data.id;
  const opened = (await A('GET', `/documents/${or}`)).data; // le bureau ouvre l'OR
  await A('PUT', '/settings', { attendance: { kiosk_pin: false } });
  const k = (await call('POST', '/kiosk/login', { user_id: mech })).data.token;
  assert.equal((await call('POST', `/kiosk/orders/${or}`, { diagnosis: 'Fuite au carter', line_id: opened.lines[0].id, done: true, mileage: 123456 }, k)).status, 200);
  assert.equal((await call('POST', `/kiosk/orders/${or}`, { mileage: 'abc' }, k)).status, 400);
  // Le bureau enregistre sa version, ouverte avant le passage du mécanicien : refusé, rien n'est perdu
  const stale = await A('PUT', `/documents/${or}`, { ...opened, notes: 'note du bureau' });
  assert.equal(stale.status, 409);
  const fresh = (await A('GET', `/documents/${or}`)).data;
  assert.equal(fresh.diagnosis, 'Fuite au carter');
  assert.equal(fresh.lines[0].done, 1);
  // Après rechargement, l'enregistrement passe et la coche « fait » du mécanicien est conservée
  assert.equal((await A('PUT', `/documents/${or}`, { ...fresh, notes: 'note du bureau', lines: fresh.lines.map((l) => ({ ...l, done: 0 })) })).status, 200);
  assert.equal((await A('GET', `/documents/${or}`)).data.lines[0].done, 1);
});

test('fiches : formulaires contrôlés, pas d\'héritage après suppression, stock', async () => {
  assert.equal((await A('POST', '/customers', {})).status, 400);
  assert.match((await A('POST', '/customers', { name: '' })).data.error, /Champ obligatoire : Nom/);
  assert.equal((await A('POST', '/customers')).status, 400, 'requête sans corps');
  assert.equal((await A('POST', '/vehicles', { plate: 1234, customer_id: 99999 })).status, 400);
  assert.equal((await A('POST', '/appointments', { start: 'demain', end: 'plus tard' })).status, 400);
  assert.equal((await A('POST', '/appointments', { start: '2026-05-01T10:00', end: '2026-05-01T09:00' })).status, 400);
  assert.equal((await A('PUT', '/customers/99999', { name: 'x' })).status, 404);
  const prod = (await A('POST', '/products', { name: 'Filtre', sale_price: '12,50', purchase_price: 8 })).data.id;
  assert.equal((await A('GET', `/products/${prod}`)).data.sale_price, 12.5, 'virgule décimale acceptée');
  assert.equal((await A('POST', '/products', { name: 'P', purchase_price: 'abc' })).status, 400);
  // Inventaire : champ vide refusé (ne met plus le stock à zéro)
  await A('POST', `/products/${prod}/adjust`, { qty: 7 });
  assert.equal((await A('POST', `/products/${prod}/adjust`, { qty: '' })).status, 400);
  assert.equal((await A('GET', `/products/${prod}`)).data.qty_on_hand, 7);
  // Fiche supprimée : ses notes et pièces jointes ne passent pas à la fiche suivante
  const old = (await A('POST', '/customers', { name: 'Ancien' })).data.id;
  await A('POST', `/chatter/customer/${old}/note`, { body: 'Note confidentielle' });
  await A('POST', `/attachments/customer/${old}`, Buffer.from('x'), { 'Content-Type': 'application/pdf', 'X-Filename': 'carte.pdf' });
  await A('DELETE', `/customers/${old}`);
  const next = (await A('POST', '/customers', { name: 'Nouveau' })).data.id;
  assert.equal(next, old, 'le numéro est repris par la fiche suivante');
  assert.equal((await A('GET', `/chatter/customer/${next}`)).data.messages.length, 0);
  assert.equal((await A('GET', `/attachments/customer/${next}`)).data.length, 0);
  // Recherche sans accents ni majuscules, plaque sans espace
  const c = (await A('POST', '/customers', { name: 'Élodie Müller' })).data.id;
  await A('POST', '/vehicles', { customer_id: c, plate: 'ab 1234' });
  assert.equal((await A('GET', '/customers?q=elodie mu')).data.length, 1);
  assert.equal((await A('GET', '/vehicles?q=AB1234')).data.length, 1);
  assert.equal((await A('GET', '/search?q=ÉLODIE')).data.customers.length, 1);
  assert.equal((await A('GET', '/customers?q=%25')).data.length, 0, 'le caractère % est cherché tel quel');
});

test('banque : relevés CSV, virement sur deux factures, annulation', async () => {
  const B = await import('../src/bank.js');
  // Colonnes « Montant débit » / « Montant crédit », priorité à la date comptable, montants avec devise ou signe à la fin
  const csv = ['Date valeur;Date comptable;Libellé;Montant débit;Montant crédit', '02/03/2026;01/03/2026;Loyer;850,00;', '03/03/2026;03/03/2026;Client;;120,50 EUR', '31/02/2026;31/02/2026;Date impossible;;10,00'].join('\n');
  const rows = B.parseCsv(csv);
  assert.deepEqual(rows.map((r) => [r.date, r.amount]), [['2026-03-01', -850], ['2026-03-03', 120.5]]);
  assert.equal(rows.rejected, 1, 'la ligne illisible est comptée');
  assert.equal(B.parseCsv('Date;Montant;Communication\n20260305;12,50-;Frais\n05.03.26;(3,00);Frais')[0].amount, -12.5);
  assert.equal(B.parseCsv('Date;D�bit;Cr�dit;Libell�\n05/03/2026;10,00;;Frais')[0].amount, -10, 'fichier Windows mal décodé');
  // Import par l'API : deux opérations identiques le même jour sont gardées ; réimporter ne double rien
  const acc = (await A('POST', '/bank-accounts', { name: 'Compte', account_code: '5131', opening_balance: '' })).data.id;
  const file = 'Date;Montant;Communication\n05/03/2026;25,00;Payconiq\n05/03/2026;25,00;Payconiq\n';
  const imp = await call('POST', `/bank/import/${acc}`, file, admin, { 'Content-Type': 'text/plain' });
  assert.equal(imp.data.added, 2);
  assert.equal((await call('POST', `/bank/import/${acc}`, file, admin, { 'Content-Type': 'text/plain' })).data.added, 0);
  assert.equal((await A('GET', '/bank-accounts')).data.find((a) => a.id === acc).statement_balance, 50, 'solde d\'ouverture vide = 0');
  assert.equal((await call('POST', '/bank/import/99999', file, admin, { 'Content-Type': 'text/plain' })).status, 404);
  // Un virement de 200 € règle deux factures de 117 € et 83 €
  const cust = (await A('POST', '/customers', { name: 'Virement' })).data.id;
  const mk = async (price) => { const id = (await A('POST', '/documents', { type: 'invoice', customer_id: cust, lines: [{ kind: 'part', description: 'x', quantity: 1, unit_price: price, tax_rate: 0 }] })).data.id; await A('POST', `/documents/${id}/post`); return id; };
  const f1 = await mk(117), f2 = await mk(83);
  await call('POST', `/bank/import/${acc}`, 'Date;Montant;Communication\n06/03/2026;200,00;Factures\n06/03/2026;-40,00;Sortie\n', admin, { 'Content-Type': 'text/plain' });
  const lines = (await A('GET', `/bank/lines?account=${acc}&status=unmatched`)).data;
  const big = lines.find((l) => l.amount === 200), out = lines.find((l) => l.amount === -40);
  assert.equal((await A('POST', `/bank/lines/${out.id}/match`, { kind: 'invoice', id: f1 })).status, 400, 'une sortie n\'encaisse pas une facture');
  assert.equal((await A('POST', `/bank/lines/${big.id}/match`, { kind: 'invoice', id: f1 })).status, 200);
  const after = (await A('GET', `/bank/lines?account=${acc}&status=unmatched`)).data.find((l) => l.id === big.id);
  assert.equal(after.remaining, 83, 'le surplus reste à affecter');
  assert.equal((await A('POST', `/bank/lines/${big.id}/match`, { kind: 'invoice', id: f2 })).status, 200);
  assert.equal((await A('GET', `/documents/${f1}`)).data.status, 'paid');
  assert.equal((await A('GET', `/documents/${f2}`)).data.status, 'paid');
  // Annuler le rapprochement : les factures redeviennent à payer, la balance reste équilibrée
  assert.equal((await A('POST', `/bank/lines/${big.id}/unmatch`)).status, 200);
  assert.equal((await A('GET', `/documents/${f1}`)).data.status, 'posted');
  assert.equal((await A('GET', `/documents/${f2}`)).data.amount_paid, 0);
  const bal = (await A('GET', '/accounting/balance?from=2000-01-01&to=2100-01-01')).data;
  const rowsBal = Array.isArray(bal) ? bal : bal.rows || [];
  assert.equal(Math.round(rowsBal.reduce((s, r) => s + r.debit - r.credit, 0) * 100), 0);
});
