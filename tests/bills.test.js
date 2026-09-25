// Factures fournisseurs encodées par l'IA (faux serveur Claude) depuis un fichier ou un e-mail.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-bills-'));
const requests = [];
let reply;
const claude = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    requests.push(JSON.parse(b));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify(reply) }] }));
  });
});

let B, Bz, db;
before(async () => {
  await new Promise((r) => claude.listen(0, r));
  Object.assign(process.env, { DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: `http://localhost:${claude.address().port}`, TZ: 'Europe/Luxembourg' });
  db = await import('../src/db.js');
  Bz = await import('../src/business.js');
  B = await import('../src/bills.js');
});
after(() => { claude.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const BILL = {
  is_invoice: true, is_credit_note: false,
  supplier: { name: 'Autodistribution Luxembourg SA', vat_number: 'LU 1234 5678', iban: null, email: null, phone: null, address: 'Zone Industrielle', zip: 'L-3895', city: 'Foetz', country: 'LU' },
  invoice_number: 'AD-99812', invoice_date: '2026-09-20', due_date: '2026-10-20', currency: 'EUR',
  lines: [
    { description: 'Filtre à huile', reference: 'hu 7008 z', quantity: 10, unit_price_ht: 6.2, tax_rate: 17, total_ht: 62, account_code: '6070' },
    { description: 'Frais de port', reference: null, quantity: 1, unit_price_ht: 12, tax_rate: 17, total_ht: 12, account_code: '9999' },
  ],
  total_ht: 74, total_tax: 12.58, total_ttc: 86.58, remarks: '',
};

test('facture fournisseur encodée par l\'IA avec pièce jointe', async () => {
  const sup = db.insert('suppliers', { name: 'Autodistribution Lux', vat_number: 'LU12345678' }, ['name', 'vat_number']);
  const prod = db.insert('products', { ref: 'HU7008Z', name: 'Filtre à huile Mann', supplier_id: sup }, ['ref', 'name', 'supplier_id']);
  reply = BILL;

  const pdf = Buffer.from('%PDF-1.4\n% facture de test\n');
  const r = await B.createBillFromFile({ buffer: pdf, mime: 'application/pdf', filename: 'AD-99812.pdf' });
  assert.equal(r.extracted, true);
  const req = requests.at(-1);
  assert.equal(req.content?.[0]?.type ?? req.messages[0].content[0].type, 'document');
  assert.equal(req.output_config.format.type, 'json_schema');

  const p = Bz.getPurchase(r.id);
  assert.equal(p.supplier_id, sup); // retrouvé par le n° de TVA malgré les espaces
  assert.equal(p.supplier_ref, 'AD-99812');
  assert.equal(p.date, '2026-09-20');
  assert.equal(p.total, 86.58);
  assert.equal(p.lines[0].product_id, prod); // article reconnu par sa référence
  assert.equal(p.lines[0].account_code, '6070');
  assert.equal(p.lines[1].account_code, null); // compte inconnu ignoré -> compte par défaut
  assert.equal(db.get('SELECT review FROM purchases WHERE id=?', r.id).review, 'to_review');
  const att = B.listAttachments('purchase', r.id);
  assert.equal(att.length, 1);
  assert.equal(fs.readFileSync(B.attachmentFile(att[0].id).full).toString(), pdf.toString());

  // Même facture une deuxième fois : doublon signalé
  const r2 = await B.createBillFromFile({ buffer: pdf, mime: 'application/pdf', filename: 'copie.pdf' });
  assert.ok(r2.warnings.some((w) => /Doublon/.test(w)));

  // Total incohérent : signalé
  reply = { ...BILL, invoice_number: 'AD-99813', total_ttc: 100 };
  const r3 = await B.createBillFromFile({ buffer: pdf, mime: 'application/pdf', filename: 'x.pdf' });
  assert.ok(r3.warnings.some((w) => /Total calculé/.test(w)));

  // Nouveau fournisseur créé automatiquement
  reply = { ...BILL, invoice_number: 'P-1', supplier: { ...BILL.supplier, name: 'Pneus Express SARL', vat_number: 'LU99999999' } };
  const r4 = await B.createBillFromFile({ buffer: pdf, mime: 'application/pdf', filename: 'p.pdf' });
  assert.equal(db.get('SELECT s.name FROM purchases p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=?', r4.id).name, 'Pneus Express SARL');

  // Réanalyse d'un brouillon : mise à jour sur place
  reply = { ...BILL, invoice_number: 'AD-99813', lines: [BILL.lines[0]], total_ttc: 72.54 };
  const rr = await B.reanalyze(r3.id);
  assert.equal(rr.id, r3.id);
  assert.equal(Bz.getPurchase(r3.id).lines.length, 1);
});

test('facture reçue par e-mail', async () => {
  reply = { ...BILL, invoice_number: 'MAIL-1' };
  const raw = await new MailComposer({
    from: 'Factures Autodis <factures@autodis.lu>', to: 'factures@garage.lu', subject: 'Votre facture MAIL-1', messageId: '<mail-1@autodis.lu>',
    text: 'Bonjour, veuillez trouver notre facture.',
    attachments: [
      { filename: 'MAIL-1.pdf', content: Buffer.from('%PDF-1.4 facture'), contentType: 'application/pdf' },
      { filename: 'logo.png', content: Buffer.alloc(500, 1), contentType: 'image/png' }, // petit logo de signature ignoré
    ],
  }).compile().build();
  const r = await B.processRawEmail(raw);
  assert.equal(r.created.length, 1);
  const p = db.get('SELECT * FROM purchases WHERE id=?', r.created[0].id);
  assert.equal(p.source, 'email');
  assert.equal(p.email_from, 'factures@autodis.lu');
  assert.match(p.notes, /Votre facture MAIL-1/);
  assert.equal(B.listAttachments('purchase', p.id)[0].filename, 'MAIL-1.pdf');
  // Le même e-mail n'est jamais traité deux fois
  assert.equal((await B.processRawEmail(raw)).skipped, true);

  // Sans IA : brouillon créé quand même, avec le document joint
  delete process.env.ANTHROPIC_API_KEY;
  const r2 = await B.createBillFromFile({ buffer: Buffer.from('%PDF-1.4'), mime: 'application/pdf', filename: 'sans-ia.pdf' });
  assert.equal(r2.extracted, false);
  assert.equal(B.listAttachments('purchase', r2.id).length, 1);
  process.env.ANTHROPIC_API_KEY = 'test';
});
