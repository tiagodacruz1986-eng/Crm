// Application « Documents » : dépôt, lecture par l'IA (simulée), rangement en dossiers, contrats et rappels,
// factures fournisseurs encodées dans les Achats, recherche, questions à l'IA, réception par e-mail, droits.
process.env.TZ ||= 'Europe/Luxembourg';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

const PORT = 5500 + Math.floor(Math.random() * 80);
const dirs = ['garage-docs-', 'garage-docs-nokey-', 'garage-docs-direct-'].map((d) => fs.mkdtempSync(path.join(os.tmpdir(), d)));
const servers = [];
let admin;

// IA simulée : répond ce qu'on a mis dans la file (un objet = fiche JSON, { tool } = appel d'outil, { text } = texte)
const queue = [];
const seen = [];
const claude = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    seen.push(JSON.parse(b));
    const next = queue.shift() ?? { text: 'ok' };
    if (next.http) { res.writeHead(next.http, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Detail' } })); return; }
    const content = next.tool ? [{ type: 'tool_use', id: 'tu_' + seen.length, name: next.tool, input: next.input || {} }] : [{ type: 'text', text: next.text ?? JSON.stringify(next) }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'test', usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: next.tool ? 'tool_use' : 'end_turn', content }));
  });
});

const CARD = { type: 'other', titre: 'Document', date_document: null, correspondant: null, reference: null, montant: null, devise: null, resume: 'Résumé.', points_cles: [], mots_cles: [], texte: '', contrat: null };
const day = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const YEAR = String(new Date().getFullYear());
const pdf = (text) => Buffer.from(`%PDF-1.4\n${text}\n%%EOF`);

async function call(method, url, body, tok, port = PORT, headers = {}) {
  const raw = Buffer.isBuffer(body);
  const res = await fetch(`http://127.0.0.1:${port}/api${url}`, {
    method, redirect: 'manual',
    headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* pas de JSON */ }
  return { status: res.status, data, text, headers: res.headers };
}
const A = (method, url, body) => call(method, url, body, admin);
const upload = (name, buf, { tok = admin, mime = 'application/pdf', folder = '', port = PORT } = {}) => call('POST', `/archives/upload${folder ? `?folder=${folder}` : ''}`, buf, tok, port, { 'Content-Type': mime, 'X-Filename': encodeURIComponent(name) });
// Attend la fin de la lecture en arrière-plan
async function ready(id, tok = admin, port = PORT) {
  for (let i = 0; i < 100; i++) {
    const d = (await call('GET', `/archives/docs/${id}`, undefined, tok, port)).data;
    if (d && !['queued', 'analyzing'].includes(d.status)) return d;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('lecture du document trop longue');
}
const folders = async () => (await A('GET', '/archives')).data.folders;
const folderId = async (p) => (await folders()).find((f) => f.path === p)?.id;
async function start(port, dataDir, env) {
  let out = '';
  const s = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, PUBLIC_URL: '', CLAUDE_MODEL: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${claude.address().port}`, ...env }, stdio: 'pipe' });
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

before(async () => {
  await new Promise((r) => claude.listen(0, '127.0.0.1', r));
  admin = await start(PORT, dirs[0], { ANTHROPIC_API_KEY: 'test' });
});
after(() => { for (const s of servers) s.kill(); claude.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('dossiers de base, puis un contrat : lu par l\'IA, rangé, rappel de résiliation planifié', async () => {
  const base = (await folders()).filter((f) => f.depth === 0).map((f) => f.name);
  for (const n of ['À classer', 'Factures fournisseurs', 'Contrats', 'Assurances', 'Véhicules', 'Banque', 'Personnel', 'Courrier', 'Divers']) assert.ok(base.includes(n), n);

  const end = day(200);
  queue.push({ ...CARD, type: 'contract', titre: 'Contrat de leasing du pont élévateur — Würth Leasing', date_document: '2024-03-01', correspondant: 'Würth Leasing', reference: 'WL-88213',
    montant: 389.5, devise: 'EUR', resume: 'Leasing du pont élévateur 4 colonnes sur 36 mois.', points_cles: ['Mensualité : 389,50 € HT', 'Préavis de 3 mois'], mots_cles: ['leasing', 'pont élévateur'],
    texte: 'Article 7 — Résiliation : le locataire peut résilier par lettre recommandée trois mois avant l\'échéance.',
    contrat: { debut: '2024-03-01', fin: end, preavis_jours: 90, date_limite_resiliation: null, reconduction_tacite: true } });
  const up = await upload('scan 0042.pdf', pdf('contrat leasing'));
  assert.equal(up.status, 200, up.text);
  const d = await ready(up.data.id);
  assert.equal(d.status, 'ready');
  assert.equal(d.title, 'Contrat de leasing du pont élévateur — Würth Leasing');
  assert.equal(d.kind, 'contract');
  assert.equal(d.folder_name, 'Contrats');
  assert.equal(d.correspondent, 'Würth Leasing');
  assert.equal(d.amount, 389.5);
  assert.deepEqual(d.facts, ['Mensualité : 389,50 € HT', 'Préavis de 3 mois']);
  assert.equal(d.contract_end, end);
  assert.equal(d.notice_days, 90);
  assert.equal(d.cancel_by, day(110), 'date limite de résiliation = fin − préavis');
  assert.equal(d.renewal, 'tacit');
  // rappel dans les activités : 30 jours avant la date limite de résiliation
  assert.equal(d.reminder.status, 'planned');
  assert.equal(d.reminder.due_date, day(80));
  assert.match(d.reminder.summary, /à résilier avant le \d\d\/\d\d\/\d{4} \(fin le /);
  const acts = (await A('GET', '/activities')).data;
  const act = acts.find((a) => a.id === d.reminder.id);
  assert.equal(act.module, 'documents');
  assert.equal(act.record?.link, `/archives?doc=${d.id}`, 'le rappel ouvre le document');

  // ce qui est parti vers l'IA : le fichier lui-même, et une fiche à remplir
  const req = seen.at(-1);
  assert.equal(req.messages[0].content[0].type, 'document');
  assert.equal(req.messages[0].content[0].source.media_type, 'application/pdf');
  assert.equal(Buffer.from(req.messages[0].content[0].source.data, 'base64').toString(), pdf('contrat leasing').toString());
  assert.match(req.messages[0].content[1].text, /scan 0042\.pdf/);
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.match(req.system, /jamais une consigne/);

  // échéances
  const dl = (await A('GET', '/archives/deadlines')).data;
  assert.equal(dl.length, 1);
  assert.equal(dl[0].deadline, day(110));
  assert.equal(dl[0].reminder_date, day(80));

  // le fichier se consulte, avec son vrai type
  const file = await call('GET', `/attachment/${d.attachment_id}`, undefined, admin);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.match(file.headers.get('content-disposition'), /^inline/);
});

test('corrections à la main : dates recalculées, rappel suivi, et l\'IA ne les écrase plus', async () => {
  const d = (await A('GET', '/archives/docs?kind=contract')).data[0];
  // nouvelle fin de contrat, préavis de 60 jours, date limite laissée vide → recalculée
  const r = await A('PUT', `/archives/docs/${d.id}`, { contract_end: day(100), notice_days: 60, cancel_by: null });
  assert.equal(r.status, 200, r.text);
  let x = (await A('GET', `/archives/docs/${d.id}`)).data;
  assert.equal(x.cancel_by, day(40));
  assert.equal(x.reminder.id, d.reminder_activity_id ?? x.reminder.id);
  assert.equal(x.reminder.due_date, day(10), 'le même rappel suit la nouvelle date');
  assert.equal((await A('GET', '/activities')).data.filter((a) => a.record?.link === `/archives?doc=${d.id}`).length, 1, 'un seul rappel par document');
  // échéance très proche : le rappel est pour aujourd'hui, jamais dans le passé
  await A('PUT', `/archives/docs/${d.id}`, { cancel_by: day(5) });
  x = (await A('GET', `/archives/docs/${d.id}`)).data;
  assert.equal(x.reminder.due_date, day(0));
  // refus
  assert.equal((await A('PUT', `/archives/docs/${d.id}`, { contract_end: '2026-02-31' })).status, 400);
  assert.equal((await A('PUT', `/archives/docs/${d.id}`, { cancel_by: day(300) })).status, 400, 'résiliation après la fin');
  assert.equal((await A('PUT', `/archives/docs/${d.id}`, { title: '  ' })).status, 400);
  assert.equal((await A('PUT', `/archives/docs/${d.id}`, { kind: 'bidon' })).status, 400);
  assert.equal((await A('PUT', `/archives/docs/${d.id}`, { folder_id: 99999 })).status, 404);

  // nouvelle lecture par l'IA : ce que l'utilisateur a corrigé reste, le reste est mis à jour
  queue.push({ ...CARD, type: 'insurance', titre: 'Autre titre', correspondant: 'Würth Leasing SA', resume: 'Nouveau résumé.', texte: 'Article 7 — Résiliation par lettre recommandée, trois mois avant l\'échéance.', contrat: { debut: '2024-03-01', fin: day(900), preavis_jours: 10, date_limite_resiliation: null, reconduction_tacite: false } });
  assert.equal((await A('POST', `/archives/docs/${d.id}/analyze`)).status, 200);
  x = await ready(d.id);
  assert.equal(x.contract_end, day(100), 'fin corrigée à la main : gardée');
  assert.equal(x.notice_days, 60);
  assert.equal(x.cancel_by, day(5));
  assert.equal(x.summary, 'Nouveau résumé.');
  assert.equal(x.correspondent, 'Würth Leasing SA');
  assert.equal(x.kind, 'insurance');
  assert.equal(x.folder_name, 'Assurances', 'rangé selon le nouveau type');

  // rappel traité, dates inchangées : pas de nouveau rappel ; dates changées : un nouveau
  await A('POST', `/activities/${x.reminder.id}/done`, {});
  await A('PUT', `/archives/docs/${d.id}`, { notes: 'Appeler M. Schmit' });
  assert.equal((await A('GET', `/archives/docs/${d.id}`)).data.reminder.status, 'done');
  await A('PUT', `/archives/docs/${d.id}`, { cancel_by: day(50) });
  x = (await A('GET', `/archives/docs/${d.id}`)).data;
  assert.equal(x.reminder.status, 'planned');
  assert.equal(x.reminder.due_date, day(20));
  // plus de date : le rappel en attente est annulé
  await A('PUT', `/archives/docs/${d.id}`, { contract_end: null, cancel_by: null, notice_days: null });
  x = (await A('GET', `/archives/docs/${d.id}`)).data;
  assert.equal(x.reminder, null);
  assert.equal((await A('GET', '/archives/deadlines')).data.length, 0);
});

test('facture fournisseur : rangée par année et encodée dans les Achats', async () => {
  const BILL = { is_invoice: true, is_credit_note: false, supplier: { name: 'Autodis SA', vat_number: 'LU12345678', iban: null, email: null, phone: null, address: null, zip: null, city: 'Luxembourg', country: 'LU' },
    invoice_number: 'AD-2026-118', invoice_date: `${YEAR}-02-10`, due_date: `${YEAR}-03-10`, currency: 'EUR',
    lines: [{ description: 'Plaquettes de frein', reference: 'BR-1', quantity: 2, unit_price_ht: 31, tax_rate: 17, total_ht: 62, account_code: '6061' }], total_ht: 62, total_tax: 10.54, total_ttc: 72.54, remarks: '' };
  queue.push({ ...CARD, type: 'invoice', titre: 'Facture Autodis AD-2026-118', date_document: `${YEAR}-02-10`, correspondant: 'Autodis SA', reference: 'AD-2026-118', montant: 72.54, devise: 'EUR' }, BILL);
  const up = await upload('facture autodis.pdf', pdf('facture autodis'));
  const d = await ready(up.data.id);
  // l'encodage dans les Achats suit la lecture : on attend le lien
  let x = d;
  for (let i = 0; i < 60 && !x.purchase; i++) { await new Promise((r) => setTimeout(r, 50)); x = (await A('GET', `/archives/docs/${d.id}`)).data; }
  assert.equal(x.kind, 'invoice');
  assert.equal((await folders()).find((f) => f.id === x.folder_id).path, `Factures fournisseurs / ${YEAR}`);
  assert.ok(x.purchase?.id, 'facture fournisseur créée');
  const p = (await A('GET', `/purchases/${x.purchase.id}`)).data;
  assert.equal(p.supplier_ref, 'AD-2026-118');
  assert.equal(p.supplier_name, 'Autodis SA');
  assert.equal(p.total, 72.54);
  assert.equal(p.posted, 0, 'brouillon à vérifier, jamais comptabilisé tout seul');
  assert.equal((await A('GET', `/attachments/purchase/${p.id}`)).data.length, 1, 'le fichier est joint à l\'achat');
  assert.equal((await A('POST', `/archives/docs/${d.id}/bill`)).status, 400, 'pas deux fois');
  // le dossier parent montre aussi les sous-dossiers, avec le bon compte
  const top = (await folders()).find((f) => f.path === 'Factures fournisseurs');
  assert.equal(top.count, 1);
  assert.equal((await A('GET', `/archives/docs?folder=${top.id}`)).data.length, 1);

  // encodage à la demande d'un document que l'IA n'avait pas vu comme une facture
  queue.push({ ...CARD, type: 'letter', titre: 'Courrier Pneus Express', date_document: `${YEAR}-01-05` });
  const up2 = await upload('courrier.pdf', pdf('courrier pneus'));
  const d2 = await ready(up2.data.id);
  assert.equal(d2.purchase, null);
  assert.equal((await folders()).find((f) => f.id === d2.folder_id).path, `Courrier / ${YEAR}`);
  queue.push({ ...BILL, invoice_number: 'PE-7', supplier: { ...BILL.supplier, name: 'Pneus Express SARL', vat_number: 'LU99999999' } });
  const enc = await A('POST', `/archives/docs/${d2.id}/bill`);
  assert.equal(enc.status, 200, enc.text);
  assert.ok(enc.data.purchase_id);
});

test('fichiers : doublon refusé, faux PDF jamais affiché, format non lisible gardé tel quel', async () => {
  const dup = await upload('copie.pdf', pdf('facture autodis'));
  assert.equal(dup.status, 400);
  assert.match(dup.data.error, /déjà dans Documents.*Facture Autodis/);
  assert.equal((await upload('vide.pdf', Buffer.alloc(0))).status, 400);

  // une page web qui se fait passer pour un PDF : gardée, mais ni lue par l'IA ni affichée dans le logiciel
  const n = seen.length;
  const fake = await upload('piege.pdf', Buffer.from('<html><script>alert(1)</script></html>'));
  const f = await ready(fake.data.id);
  assert.equal(f.mime, 'application/octet-stream');
  assert.equal(f.status, 'manual');
  assert.match(f.ai_error, /pas lisible par l'IA/);
  assert.equal(f.folder_name, 'À classer');
  assert.equal(seen.length, n, 'rien n\'est parti vers l\'IA');
  const file = await call('GET', `/attachment/${f.attachment_id}`, undefined, admin);
  assert.equal(file.headers.get('content-type'), 'application/octet-stream');
  assert.match(file.headers.get('content-disposition'), /^attachment/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  // un tableur : gardé tel quel, à classer à la main
  const xls = await upload('tarifs.xlsx', Buffer.from('PK\u0003\u0004 contenu'), { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const x = await ready(xls.data.id);
  assert.equal(x.status, 'manual');
  assert.equal(x.title, 'tarifs');
  // une image annoncée comme PDF : son vrai type est gardé, et elle part bien comme image
  queue.push({ ...CARD, type: 'vehicle', titre: 'Carte grise AB 1234' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const img = await upload('carte grise.pdf', png);
  const i = await ready(img.data.id);
  assert.equal(i.mime, 'image/png');
  assert.equal(i.folder_name, 'Véhicules');
  assert.equal(seen.at(-1).messages[0].content[0].type, 'image');
  // la lecture échoue : le document reste, avec un message, et peut être relu
  queue.push({ http: 500 }, { http: 500 });
  const ko = await upload('illisible.pdf', pdf('document abîmé'));
  const k = await ready(ko.data.id);
  assert.equal(k.status, 'error');
  assert.ok(k.ai_error);
  assert.equal(k.folder_name, 'À classer');
  queue.push({ ...CARD, type: 'tax', titre: 'Décompte TVA', date_document: '2025-12-31' });
  assert.equal((await A('POST', '/archives/analyze-pending')).data.queued, 1, 'seuls les documents lisibles sont relancés');
  const k2 = await ready(k.id);
  assert.equal(k2.status, 'ready');
  assert.equal((await folders()).find((x2) => x2.id === k2.folder_id).path, 'Impôts & administration / 2025');
});

test('dossiers : créer, renommer, déplacer, supprimer', async () => {
  const contrats = await folderId('Contrats');
  const mk = await A('POST', '/archives/folders', { name: '  Téléphonie / Internet ', parent_id: contrats });
  assert.equal(mk.status, 200, mk.text);
  assert.equal((await folders()).find((f) => f.id === mk.data.id).path, 'Contrats / Téléphonie Internet');
  assert.equal((await A('POST', '/archives/folders', { name: 'téléphonie internet', parent_id: contrats })).status, 400, 'même nom au même endroit');
  assert.equal((await A('POST', '/archives/folders', { name: '' })).status, 400);
  assert.equal((await A('POST', '/archives/folders', { name: 'X', parent_id: 99999 })).status, 404);
  assert.equal((await A('PUT', `/archives/folders/${mk.data.id}`, { name: 'Télécom' })).status, 200);
  assert.equal((await A('PUT', `/archives/folders/${contrats}`, { name: 'Mes contrats' })).status, 200, 'un dossier de base se renomme');
  assert.equal((await A('DELETE', `/archives/folders/${contrats}`)).status, 400, 'mais ne se supprime pas');

  // déplacer un document : le dossier choisi à la main est gardé, même après une nouvelle lecture
  const doc = (await A('GET', '/archives/docs?q=carte grise')).data[0];
  assert.equal((await A('PUT', `/archives/docs/${doc.id}`, { folder_id: mk.data.id })).status, 200);
  queue.push({ ...CARD, type: 'vehicle', titre: 'Carte grise AB 1234 (relue)' });
  await A('POST', `/archives/docs/${doc.id}/analyze`);
  const again = await ready(doc.id);
  assert.equal(again.title, 'Carte grise AB 1234 (relue)');
  assert.equal(again.folder_id, mk.data.id);
  assert.equal((await A('DELETE', `/archives/folders/${mk.data.id}`)).status, 400, 'dossier non vide');
  // dépôt direct dans un dossier : il y reste
  queue.push({ ...CARD, type: 'bank', titre: 'Relevé de compte' });
  const up = await upload('releve.pdf', pdf('relevé'), { folder: mk.data.id });
  assert.equal((await ready(up.data.id)).folder_id, mk.data.id);
  assert.equal((await upload('x.pdf', pdf('x'), { folder: 99999 })).status, 404);
  // vidé, le dossier se supprime
  const divers = await folderId('Divers');
  for (const d of (await A('GET', `/archives/docs?folder=${mk.data.id}`)).data) await A('PUT', `/archives/docs/${d.id}`, { folder_id: divers });
  assert.equal((await A('DELETE', `/archives/folders/${mk.data.id}`)).status, 200);
  assert.equal(await folderId('Mes contrats / Télécom'), undefined);
});

test('recherche par mots (accents et majuscules ignorés) et questions à l\'IA avec citation des documents', async () => {
  const find = async (q) => (await A('GET', `/archives/docs?q=${encodeURIComponent(q)}`)).data.map((d) => d.title);
  assert.deepEqual(await find('wurth'), ['Autre titre'], 'accents ignorés');
  assert.deepEqual(await find('RÉSILIATION recommandée'), ['Autre titre'], 'le contenu recopié est cherché, tous les mots demandés');
  assert.deepEqual(await find('résiliation pneus'), []);
  assert.ok((await find('100%')).length === 0, 'les signes % et _ sont pris tels quels');
  assert.equal((await A('GET', '/archives/docs?kind=invoice')).data.length, 1);

  const doc = (await A('GET', '/archives/docs?q=wurth')).data[0];
  const n = seen.length;
  queue.push({ tool: 'chercher_documents', input: { recherche: 'leasing' } }, { tool: 'lire_document', input: { id: doc.id } },
    { text: `Le préavis est de **60 jours** [doc:${doc.id}]. Voir aussi [doc:99999].` });
  const r = await A('POST', '/archives/ask', { question: 'Quel est le préavis du leasing du pont ?' });
  assert.equal(r.status, 200, r.text);
  assert.match(r.data.answer, /60 jours/);
  assert.deepEqual(r.data.documents.map((d) => d.id), [doc.id], 'seuls les documents qui existent sont proposés');
  const first = seen[n];
  assert.deepEqual(first.tools.map((t) => t.name), ['chercher_documents', 'lire_document', 'relire_original', 'echeances_contrats']);
  assert.match(first.system[0].text, /\[doc:12\]/);
  // le résultat de la recherche, puis la fiche complète, sont bien revenus à l'IA
  const found = JSON.parse(seen[n + 1].messages.at(-1).content[0].content);
  assert.equal(found[0].id, doc.id);
  const card = JSON.parse(seen[n + 2].messages.at(-1).content[0].content);
  assert.equal(card.titre, 'Autre titre');
  assert.equal(card.resume, 'Nouveau résumé.');
  assert.match(card.contenu, /lettre recommandée/);
  // relire le fichier d'origine pour une question précise
  queue.push({ tool: 'relire_original', input: { id: doc.id, question: 'Que dit l\'article 7 ?' } }, { text: 'Article 7 : résiliation par lettre recommandée.' }, { text: `Par lettre recommandée [doc:${doc.id}].` });
  const r2 = await A('POST', '/archives/ask', { question: 'Comment résilier ?' });
  assert.equal(r2.status, 200, r2.text);
  const reread = seen.at(-2);
  assert.equal(reread.messages[0].content[0].type, 'document', 'le fichier d\'origine est relu');
  assert.match(reread.messages[0].content[1].text, /article 7/);
  // refus
  assert.equal((await A('POST', '/archives/ask', { question: '  ' })).status, 400);
  assert.equal((await A('POST', '/archives/ask', { question: 'x'.repeat(1001) })).status, 400);
  assert.equal((await A('POST', '/archives/ask', {})).status, 400);
});

test('droits : lecture pour consulter et interroger, utilisateur pour déposer, administrateur pour supprimer', async () => {
  const none = await userWith({ ventes: 'manager', achats: 'manager', ia: 'manager' }, 'sans');
  const reader = await userWith({ archives: 'read' }, 'lecteur');
  const user = await userWith({ archives: 'user' }, 'utilisateur');
  const buyer = await userWith({ archives: 'user', achats: 'user' }, 'acheteur');
  const manager = await userWith({ archives: 'manager' }, 'responsable');
  const doc = (await A('GET', '/archives/docs?q=wurth')).data[0];
  const g = (url, tok) => call('GET', url, undefined, tok);
  for (const url of ['/archives', '/archives/docs', `/archives/docs/${doc.id}`, '/archives/deadlines', `/attachment/${doc.attachment_id}`, `/attachments/archive/${doc.id}`]) {
    assert.equal((await g(url, none)).status, 403, url);
    assert.equal((await g(url, reader)).status, 200, url);
    assert.equal((await g(url, null)).status, 401, url);
  }
  // le modèle « Bureau / accueil » ne donne pas l'application (papiers sensibles) : le gérant l'accorde lui-même
  const meta = (await A('GET', '/access/meta')).data;
  for (const k of ['bureau', 'comptable', 'lecture', 'chef_atelier']) assert.equal(meta.presets[k].perms.archives, 'none', k);
  assert.equal(meta.presets.admin.perms.archives, 'manager');

  queue.push({ text: 'Rien trouvé.' });
  assert.equal((await call('POST', '/archives/ask', { question: 'leasing ?' }, reader)).status, 200, 'interroger = lecture');
  assert.equal((await call('POST', '/archives/ask', { question: 'leasing ?' }, none)).status, 403);
  assert.equal((await upload('l.pdf', pdf('lecteur'), { tok: reader })).status, 403);
  assert.equal((await call('PUT', `/archives/docs/${doc.id}`, { title: 'X' }, reader)).status, 403);
  assert.equal((await call('POST', '/archives/folders', { name: 'X' }, reader)).status, 403);
  assert.equal((await call('POST', `/archives/docs/${doc.id}/analyze`, {}, reader)).status, 403);

  queue.push({ ...CARD, type: 'letter', titre: 'Lettre' });
  const up = await upload('u.pdf', pdf('utilisateur'), { tok: user });
  assert.equal(up.status, 200);
  await ready(up.data.id, user);
  assert.equal((await call('PUT', `/archives/docs/${up.data.id}`, { title: 'Lettre du 3 mars' }, user)).status, 200);
  assert.equal((await call('DELETE', `/archives/docs/${up.data.id}`, undefined, user)).status, 403, 'supprimer : administrateur de l\'application');
  assert.equal((await call('DELETE', `/attachment/${(await g(`/archives/docs/${up.data.id}`, user)).data.attachment_id}`, undefined, user)).status, 400, 'le fichier ne se retire pas à part');
  assert.equal((await call('DELETE', `/attachment/${doc.attachment_id}`, undefined, admin)).status, 400);
  assert.equal((await call('POST', `/archives/docs/${up.data.id}/bill`, {}, user)).status, 403, 'encoder une facture demande aussi les Achats');
  queue.push({ is_invoice: false, is_credit_note: false, supplier: { name: 'Inconnu', vat_number: null, iban: null, email: null, phone: null, address: null, zip: null, city: null, country: null }, invoice_number: null, invoice_date: null, due_date: null, currency: 'EUR', lines: [], total_ht: null, total_tax: null, total_ttc: null, remarks: '' });
  assert.equal((await call('POST', `/archives/docs/${up.data.id}/bill`, {}, buyer)).status, 200);
  // réglages et boîte e-mail : administrateur du logiciel
  for (const tok of [reader, user, manager]) {
    assert.equal((await g('/archives/inbox', tok)).status, 403);
    assert.equal((await call('PUT', '/archives/inbox', { host: 'x' }, tok)).status, 403);
    assert.equal((await call('PUT', '/archives/config', { auto_bills: false }, tok)).status, 403);
  }
  assert.equal((await call('DELETE', `/archives/docs/${up.data.id}`, undefined, manager)).status, 200);
  assert.equal((await g(`/archives/docs/${up.data.id}`, manager)).status, 404);
});

test('suppression : le fichier et le rappel partent avec le document ; mot de passe de la boîte jamais renvoyé', async () => {
  queue.push({ ...CARD, type: 'contract', titre: 'Contrat photocopieur', contrat: { debut: null, fin: day(400), preavis_jours: null, date_limite_resiliation: null, reconduction_tacite: null } });
  const up = await upload('copieur.pdf', pdf('copieur'));
  const d = await ready(up.data.id);
  assert.match(d.reminder.summary, /se termine le/);
  assert.equal(d.reminder.due_date, day(370));
  const file = path.join(dirs[0], 'uploads', 'attachments');
  const before = fs.readdirSync(file).length;
  assert.equal((await A('DELETE', `/archives/docs/${d.id}`)).status, 200);
  assert.equal(fs.readdirSync(file).length, before - 1);
  assert.equal((await A('GET', '/activities')).data.find((a) => a.id === d.reminder.id), undefined, 'rappel annulé');
  assert.equal((await call('GET', `/attachment/${d.attachment_id}`, undefined, admin)).status, 404);
  assert.equal((await A('DELETE', `/archives/docs/${d.id}`)).status, 404);

  // réglages
  assert.equal((await A('PUT', '/archives/config', { reminder_days: 400 })).status, 400);
  assert.deepEqual((await A('PUT', '/archives/config', { reminder_days: 45, auto_bills: false })).data, { auto_bills: false, reminder_days: 45 });
  const saved = await A('PUT', '/archives/inbox', { enabled: true, host: 'imap.test.lu', user: 'documents@garage.lu', pass: 'MotDePasseSecret!', allowed_senders: 'Scan@Garage.lu; @fiduciaire.lu' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.has_pass, true);
  assert.equal(saved.data.allowed_senders, 'scan@garage.lu, @fiduciaire.lu');
  const reader = (await call('POST', '/auth/login', { email: 'lecteur@t.lu', password: 'secret123' })).data.token;
  for (const [url, tok] of [['/archives/inbox', admin], ['/archives', admin], ['/archives', reader], ['/settings', admin], ['/settings', reader]]) {
    const r = await call('GET', url, undefined, tok);
    assert.ok(!r.text.includes('MotDePasseSecret'), `le mot de passe ne doit pas sortir par ${url}`);
  }
  assert.deepEqual((await call('GET', '/archives', undefined, reader)).data.inbox, { enabled: true, address: 'documents@garage.lu', status: null });
  // avec « encodage automatique » coupé, une facture n'est plus encodée toute seule
  queue.push({ ...CARD, type: 'invoice', titre: 'Facture sans encodage', date_document: `${YEAR}-04-01` });
  const inv = await ready((await upload('f2.pdf', pdf('facture 2'))).data.id);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await A('GET', `/archives/docs/${inv.id}`)).data.purchase, null);
});

test('sans clé IA : le document est gardé dans « À classer », la recherche marche, les questions sont refusées', async () => {
  const tok = await start(PORT + 100, dirs[1], { ANTHROPIC_API_KEY: '' });
  const n = seen.length;
  const up = await upload('bail du local.pdf', pdf('bail'), { tok, port: PORT + 100 });
  assert.equal(up.status, 200);
  const d = await ready(up.data.id, tok, PORT + 100);
  assert.equal(d.status, 'manual');
  assert.equal(d.ai_error, null);
  assert.equal(d.title, 'bail du local');
  assert.equal(d.folder_name, 'À classer');
  assert.equal((await call('GET', '/archives/docs?q=bail', undefined, tok, PORT + 100)).data.length, 1);
  const ask = await call('POST', '/archives/ask', { question: 'bail ?' }, tok, PORT + 100);
  assert.equal(ask.status, 400);
  assert.match(ask.data.error, /aucune clé Claude/);
  assert.equal((await call('POST', `/archives/docs/${d.id}/analyze`, {}, tok, PORT + 100)).status, 400);
  assert.equal((await call('POST', '/archives/analyze-pending', {}, tok, PORT + 100)).status, 400);
  // fiche remplie à la main : classement et rappel fonctionnent sans IA
  const contrats = (await call('GET', '/archives', undefined, tok, PORT + 100)).data.folders.find((f) => f.name === 'Contrats').id;
  const r = await call('PUT', `/archives/docs/${d.id}`, { kind: 'contract', folder_id: contrats, contract_end: day(365), notice_days: 180 }, tok, PORT + 100);
  assert.equal(r.status, 200, r.text);
  const x = (await call('GET', `/archives/docs/${d.id}`, undefined, tok, PORT + 100)).data;
  assert.equal(x.cancel_by, day(185));
  assert.equal(x.reminder.due_date, day(155));
  assert.equal(seen.length, n, 'rien n\'est parti vers l\'IA');
});

test('réception par e-mail : pièces jointes rangées, signature et invitations ignorées, expéditeurs autorisés', async () => {
  Object.assign(process.env, { DATA_DIR: dirs[2], ANTHROPIC_API_KEY: 'test', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${claude.address().port}` });
  const db = await import('../src/db.js');
  const D = await import('../src/archives.js');
  db.insert('users', { name: 'Gérant', email: 'g@t.lu', role: 'admin' }, ['name', 'email', 'role']);
  const idle = async () => { for (let i = 0; i < 100 && !D.queueIdle(); i++) await new Promise((r) => setTimeout(r, 30)); await new Promise((r) => setTimeout(r, 30)); };
  const mail = (opts) => new MailComposer({ from: 'Assurances Foyer <contrats@foyer.lu>', to: 'documents@garage.lu', text: 'Bonjour, voici votre police.', ...opts }).compile().build();

  queue.push({ ...CARD, type: 'insurance', titre: 'Police responsabilité civile — Foyer', correspondant: 'Foyer Assurances', contrat: { debut: null, fin: day(120), preavis_jours: 30, date_limite_resiliation: null, reconduction_tacite: true } });
  const raw = await mail({ subject: 'Votre police RC 2027', messageId: '<m1@foyer.lu>', attachments: [
    { filename: 'police-rc.pdf', content: pdf('police rc'), contentType: 'application/pdf' },
    { filename: 'logo.png', content: Buffer.alloc(500, 1), contentType: 'image/png' }, // petit logo de signature
    { filename: 'invite.ics', content: Buffer.from('BEGIN:VCALENDAR'), contentType: 'text/calendar' },
    { filename: 'smime.p7s', content: Buffer.alloc(2000, 2), contentType: 'application/pkcs7-signature' },
  ] });
  const r = await D.processRawEmail(raw);
  assert.equal(r.created.length, 1, 'seul le PDF est un document');
  await idle();
  const d = D.getDoc(r.created[0]);
  assert.equal(d.status, 'ready');
  assert.equal(d.source, 'email');
  assert.equal(d.email_from, 'contrats@foyer.lu');
  assert.equal(d.folder_name, 'Assurances');
  assert.equal(d.cancel_by, day(90));
  assert.equal(d.reminder.due_date, day(60), 'rappel créé pour le gérant, même sans personne devant l\'écran');
  assert.match(seen.at(-1).messages[0].content[1].text, /objet : Votre police RC 2027/);
  // le même e-mail relu, ou le même fichier renvoyé : pas de doublon
  assert.equal((await D.processRawEmail(raw)).skipped, true);
  const again = await D.processRawEmail(await mail({ subject: 'Rappel', messageId: '<m2@foyer.lu>', attachments: [{ filename: 'police-rc (1).pdf', content: pdf('police rc'), contentType: 'application/pdf' }] }));
  assert.equal(again.created.length, 0);
  assert.equal(again.result, 'déjà reçu');
  assert.equal((await D.processRawEmail(await mail({ subject: 'Sans pièce', messageId: '<m3@foyer.lu>' }))).result, 'aucune pièce jointe');
  assert.equal(D.listDocs().length, 1);

  // expéditeurs autorisés : les autres sont ignorés (rien n'est gardé, rien n'est lu)
  D.saveInboxConfig({ allowed_senders: 'scan@garage.lu, @fiduciaire.lu' });
  const n = seen.length;
  const no = await D.processRawEmail(await mail({ subject: 'Offre', messageId: '<m4@spam.com>', from: 'promo@spam.com', attachments: [{ filename: 'offre.pdf', content: pdf('pub'), contentType: 'application/pdf' }] }));
  assert.equal(no.result, 'expéditeur non autorisé');
  assert.equal(D.listDocs().length, 1);
  queue.push({ ...CARD, type: 'tax', titre: 'Bilan 2025', date_document: '2026-03-15' });
  const yes = await D.processRawEmail(await mail({ subject: 'Bilan', messageId: '<m5@fiduciaire.lu>', from: 'Marie <marie@fiduciaire.lu>', attachments: [{ filename: 'bilan.pdf', content: pdf('bilan'), contentType: 'application/pdf' }] }));
  assert.equal(yes.created.length, 1);
  await idle();
  assert.equal(seen.length, n + 1);
  assert.equal(D.getDoc(yes.created[0]).folder_name, '2026');
  // boîte non réglée : message clair
  D.saveInboxConfig({ host: '', user: '' });
  await assert.rejects(D.testInbox(), /Renseignez le serveur IMAP/);
  await assert.rejects(D.checkInbox(), /Renseignez le serveur IMAP/);
});
