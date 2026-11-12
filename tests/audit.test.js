// Corrections issues de l'audit : droits d'accès, présences, calculs, banque, e-mails.
// Le test démarre un vrai serveur sur une base vide et passe par l'API, comme le navigateur.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4000 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-audit-'));
// Les modules importés directement par ce fichier (calculs, lecture de relevés) travaillent sur une base temporaire à part,
// jamais sur les données réelles du garage
const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-audit-unit-'));
process.env.DATA_DIR = unitDir;
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
after(() => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(unitDir, { recursive: true, force: true }); });

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
  assert.equal(mine.data.some((a) => a.id === act), false, 'activité d\'une fiche qu\'il ne peut pas lire : invisible');
  // adresse encodée (%31 pour 1) : refusée, elle ne contourne pas les règles de droits
  assert.equal((await call('GET', `/attachments/customer/%3${String(cust).slice(-1)}`, undefined, zero.tok)).status, 400);
  assert.equal((await call('GET', `/chatter/%63ustomer/${cust}`, undefined, zero.tok)).status, 400);
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
  // Un devis transformé en OR ne se facture plus directement (le travail serait facturé deux fois)
  const q = (await A('POST', '/documents', { type: 'quote', customer_id: cust, lines: [line] })).data.id;
  assert.equal((await A('POST', `/documents/${q}/convert`, { type: 'order' })).status, 200);
  assert.equal((await A('POST', `/documents/${q}/convert`, { type: 'invoice' })).status, 400);
  // Encaisser : le droit « Utilisateur » sur Ventes suffit (profil « Bureau / accueil »)
  const bureau = await userWith({ ventes: 'user', banque: 'read' });
  assert.equal((await call('POST', `/documents/${inv2}/payments`, { amount: 1 }, bureau.tok)).status, 200);
  assert.equal((await call('DELETE', '/payments/1', undefined, bureau.tok)).status, 403, 'annuler un paiement : administrateurs de la banque');
  // Paiements : pas plus que le reste dû (116 €)
  assert.equal((await A('POST', `/documents/${inv2}/payments`, { amount: 200 })).status, 400);
  assert.equal((await A('POST', `/documents/${inv2}/payments`, { amount: 16 })).status, 200);
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
  // Après rechargement, l'enregistrement passe : la coche du mécanicien est conservée et la ligne garde son identifiant
  assert.equal((await A('PUT', `/documents/${or}`, { ...fresh, notes: 'note du bureau' })).status, 200);
  const saved = (await A('GET', `/documents/${or}`)).data;
  assert.equal(saved.lines[0].done, 1);
  assert.equal(saved.lines[0].id, fresh.lines[0].id, 'identifiant de ligne stable (le kiosque s\'y réfère)');
  // Le bureau peut aussi décocher « fait » ; changer le statut ou l'étape du suivi ne provoque pas de faux conflit
  await A('POST', `/documents/${or}/status`, { status: 'in_progress' });
  await A('POST', `/live/${or}/stage`, { stage: 'repair' });
  assert.equal((await A('PUT', `/documents/${or}`, { ...saved, lines: saved.lines.map((l) => ({ ...l, done: 0 })) })).status, 200, 'pas de conflit après un changement de statut');
  assert.equal((await A('GET', `/documents/${or}`)).data.lines[0].done, 0);
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

test('CRM : colonne « Gagné », étapes, titre vide, devis qui ne fait pas reculer', async () => {
  const meta = (await A('GET', '/crm/meta')).data;
  const won = meta.stages.find((x) => x.is_won), nego = meta.stages.find((x) => /N[ée]go/i.test(x.name)), quoteStage = meta.stages.find((x) => /^Devis/i.test(x.name));
  const id = (await A('POST', '/crm/leads', { name: 'Flotte taxis', contact_name: 'Max', phone: '691 000 111', expected_revenue: 900 })).data.id;
  // Titre vidé : l'ancien est gardé (il ne devient pas « null »)
  await A('PUT', `/crm/leads/${id}`, { name: null, phone: '691 000 222' });
  assert.equal((await A('GET', `/crm/leads/${id}`)).data.name, 'Flotte taxis');
  // « Nouveau devis » ne fait pas reculer une opportunité déjà en négociation
  if (nego && quoteStage && nego.sequence > quoteStage.sequence) {
    await A('POST', `/crm/leads/${id}/move`, { stage_id: nego.id });
    assert.equal((await A('POST', `/crm/leads/${id}/quote`)).status, 200);
    assert.equal((await A('GET', `/crm/leads/${id}`)).data.stage_id, nego.id);
  }
  // Gagnée : visible dans le tableau (statut « pipeline »), et un simple enregistrement ne la « dé-gagne » pas
  assert.equal((await A('POST', `/crm/leads/${id}/won`)).data.status, 'won');
  assert.ok((await A('GET', '/crm/leads?status=pipeline')).data.some((l) => l.id === id));
  await A('PUT', `/crm/leads/${id}`, { ...(await A('GET', `/crm/leads/${id}`)).data, phone: '691 000 333' });
  assert.equal((await A('GET', `/crm/leads/${id}`)).data.status, 'won');
  // Renommer l'étape gagnante ne lui retire pas son rôle
  assert.equal((await A('PUT', `/crm/stages/${won.id}`, { name: 'Gagné 🏆' })).status, 200);
  assert.equal((await A('GET', '/crm/meta')).data.stages.find((x) => x.id === won.id).is_won, 1);
  assert.equal((await A('PUT', `/crm/stages/${won.id}`, { is_won: false })).status, 400, 'il faut garder une étape « Gagné »');
  // Perdue : date de perte enregistrée ; supprimée : ses activités disparaissent
  const l2 = (await A('POST', '/crm/leads', { name: 'À supprimer' })).data.id;
  await A('POST', '/activities', { model: 'lead', record_id: l2, summary: 'Rappeler le prospect', due_date: '2030-01-01' });
  assert.ok((await A('POST', `/crm/leads/${l2}/lost`, { reason: 'Trop cher' })).data.lost_at);
  await A('DELETE', `/crm/leads/${l2}`);
  assert.equal((await A('GET', '/activities')).data.some((a) => a.summary === 'Rappeler le prospect'), false);
});

test('e-mails : envoi programmé dans le passé refusé, brouillon de facture non envoyé, contenu échappé', async () => {
  const cust = (await A('POST', '/customers', { name: 'Mail <b>Test</b>', email: 'client@t.lu' })).data.id;
  const inv = (await A('POST', '/documents', { type: 'invoice', customer_id: cust, lines: [{ kind: 'part', description: '<img src=x onerror=alert(1)>', quantity: 1, unit_price: 10, tax_rate: 17 }] })).data.id;
  // Facture en brouillon : pas de modèle « Facture null », et pas d'envoi du document sans numéro
  const c = (await A('GET', `/mail/compose?model=document&id=${inv}`)).data;
  assert.equal(/null/.test(c.subject + c.intro), false);
  assert.equal((await A('POST', '/mail/send', { model: 'document', record_id: inv, to: 'client@t.lu', subject: 'Facture', intro: 'x', include_document: true })).status, 400);
  await A('POST', `/documents/${inv}/post`);
  const html = (await A('POST', '/mail/preview', { model: 'document', record_id: inv, intro: 'Bonjour', include_document: true })).data.html;
  assert.equal(/<img src=x/.test(html), false, 'le texte des lignes est échappé');
  // Programmation : heure passée refusée (elle partait tout de suite), heure à venir acceptée puis annulable par un simple utilisateur
  const past = await A('POST', '/mail/send', { model: 'document', record_id: inv, to: 'client@t.lu', subject: 'Facture', intro: 'x', scheduled_at: '2020-01-01T08:00' });
  assert.equal(past.status, 400);
  const user = await userWith({ emails: 'user', ventes: 'read' });
  const later = await call('POST', '/mail/send', { model: 'document', record_id: inv, to: 'client@t.lu', subject: 'Facture', intro: 'x', scheduled_at: '2099-01-01T08:00' }, user.tok);
  assert.equal(later.data.status, 'scheduled');
  assert.equal((await call('DELETE', `/mail/${later.data.id}`, undefined, user.tok)).status, 200);
  // Rédaction par l'IA sans clé : erreur claire, le texte de l'utilisateur n'est pas remplacé
  assert.equal((await A('POST', '/mail/draft-ai', { intro: 'Mon texte' })).status, 400);
});

test('IA : les agents ne donnent à chacun que ce qu\'il a le droit de voir', async () => {
  const AG = await import('../src/agents.js');
  const chef = { id: 99, name: 'Chef', role: 'office', permissions: JSON.stringify({ ia: 'user', atelier: 'manager' }) };
  assert.throws(() => AG.runTool('comptabilite', { depuis: '2026-01-01', jusqu_au: '2026-12-31' }, chef), /Accès refusé/);
  assert.throws(() => AG.runTool('lister_documents', { type: 'invoice' }, chef), /Accès refusé/);
  assert.doesNotThrow(() => AG.runTool('lister_documents', { type: 'order' }, chef));
  const d = AG.runTool('tableau_de_bord', {}, chef);
  assert.equal(d.bank, null);
  assert.equal(d.salesMonth, null);
  assert.notEqual(AG.runTool('tableau_de_bord', {}, null).bank, null, 'tâche du gérant : tout est visible');
  // Chiffres du jour et résumé : réservés selon les droits
  const u = await userWith({ ia: 'user' });
  const st = (await call('GET', '/copilot/stats', undefined, u.tok)).data;
  assert.equal('encaissements' in st || 'factures_emises' in st, false);
  assert.equal((await call('POST', '/copilot/brief', {}, u.tok)).status, 403);
  assert.deepEqual((await call('GET', '/copilot', undefined, u.tok)).data.briefs, []);
});

test('second contrôle : invitations, bureau IA, achats reçus, avoir et paiement annulé, fiches client', async () => {
  // Le lien d'invitation n'est jamais lisible dans la boîte d'envoi
  await A('PUT', '/mail/config', { host: 'smtp.test', from_email: 'garage@t.lu' });
  const invited = (await A('POST', '/users', { name: 'Nouvelle', email: 'nouvelle@t.lu', role: 'office', invite: true, send_invite: true })).data;
  assert.match(invited.invite.url, /\/invite\/[a-f0-9]{48}$/);
  const colleague = await userWith({ emails: 'user' });
  const outbox = (await call('GET', '/mail/outbox', undefined, colleague.tok)).data;
  assert.equal(outbox.some((e) => /invite\//.test(e.intro || '') || e.model === 'user'), false);
  assert.equal((await A('GET', '/mail/outbox')).data.some((e) => /invite\//.test(e.intro || '')), false, 'même le gérant ne retrouve pas le lien');
  // Le jeton de session n'est pas renvoyé par /auth/status
  assert.equal('token' in ((await A('GET', '/auth/status')).data.user || {}), false);
  // Bureau IA : chacun ses tâches et ses rapports
  const u1 = await userWith({ ia: 'user' }), u2 = await userWith({ ia: 'user' });
  const task = (await call('POST', '/agent-tasks', { agent_id: 'cio', title: 'Ma tâche', prompt: 'Résume', schedule_type: 'daily', schedule_time: '08:00' }, u1.tok)).data.id;
  assert.equal((await call('GET', '/agent-tasks', undefined, u2.tok)).data.length, 0);
  assert.equal((await call('PUT', `/agent-tasks/${task}`, { prompt: 'Autre chose' }, u2.tok)).status, 404);
  assert.equal((await call('DELETE', `/agent-tasks/${task}`, undefined, u2.tok)).status, 404);
  assert.equal((await A('GET', '/agent-tasks')).data.some((t) => t.id === task), true, 'le gérant voit tout');
  assert.equal((await call('POST', '/agent-tasks', { agent_id: 'cio', title: 'x', prompt: 'y', schedule_time: '25:99' }, u1.tok)).status, 400);
  // Achat : une ligne déjà réceptionnée ne se supprime pas et ne descend pas sous la quantité reçue
  const sup = (await A('POST', '/suppliers', { name: 'Pièces SA' })).data.id;
  const prod = (await A('POST', '/products', { name: 'Plaquettes', purchase_price: 20, sale_price: 40 })).data.id;
  const pu = (await A('POST', '/purchases', { supplier_id: sup, lines: [{ product_id: prod, description: 'Plaquettes', quantity: 4, unit_price: 20, tax_rate: 17 }] })).data.id;
  await A('POST', `/purchases/${pu}/receive`);
  const line = (await A('GET', `/purchases/${pu}`)).data.lines[0];
  assert.equal((await A('PUT', `/purchases/${pu}`, { lines: [] })).status, 400);
  assert.equal((await A('PUT', `/purchases/${pu}`, { lines: [{ ...line, quantity: 1 }] })).status, 400);
  assert.equal((await A('PUT', `/purchases/${pu}`, { lines: [{ ...line, quantity: 6 }] })).status, 200);
  assert.equal((await A('GET', `/products/${prod}`)).data.qty_on_hand, 4);
  // Facture payée, puis créditée, puis paiement annulé : la note de crédit couvre la facture (elle ne redevient pas « à payer »)
  const cust = (await A('POST', '/customers', { name: 'Crédit' })).data.id;
  const inv = (await A('POST', '/documents', { type: 'invoice', customer_id: cust, lines: [{ kind: 'part', description: 'x', quantity: 1, unit_price: 100, tax_rate: 0 }] })).data.id;
  await A('POST', `/documents/${inv}/post`);
  const pay = (await A('POST', `/documents/${inv}/payments`, { amount: 100 })).data.id;
  const cn = (await A('POST', `/documents/${inv}/convert`, { type: 'credit_note' })).data.id;
  await A('POST', `/documents/${cn}/post`);
  assert.equal((await A('DELETE', `/payments/${pay}`)).status, 200);
  assert.equal((await A('GET', `/documents/${inv}`)).data.status, 'paid', 'soldée par la note de crédit');
  assert.equal((await A('GET', `/documents/${cn}`)).data.status, 'paid');
  // Fiche client : les factures ne sont montrées qu'avec le droit Ventes
  const mag = await userWith({ contacts: 'read', inventaire: 'user' });
  const card = (await call('GET', `/customers/${cust}`, undefined, mag.tok)).data;
  assert.equal(card.documents.length, 0);
  assert.equal((await call('GET', '/customers', undefined, mag.tok)).data.find((c) => c.id === cust).balance, null);
  // Paramètres de l'atelier contrôlés
  assert.equal((await A('PUT', '/settings', { workshop: { default_tax: '' } })).status, 400);
  assert.equal((await A('PUT', '/settings', { workshop: { payment_terms: -5 } })).status, 400);
  assert.equal((await A('PUT', '/settings', { workshop: { labor_rate: '92,5' } })).data.workshop.labor_rate, 92.5);
});
