// Test de bout en bout : achat -> stock -> devis -> OR -> pointage -> facture -> banque -> comptabilité.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-test-'));
let server, token, kioskToken;

async function call(method, url, body, tok = token) {
  const res = await fetch(BASE + url, {
    method, headers: { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${data?.error}`);
  return data;
}

before(async () => {
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ANTHROPIC_API_KEY: '' }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/auth/status`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('serveur non démarré');
});
after(() => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('parcours complet du garage', async () => {
  ({ token } = await call('POST', '/auth/setup', { name: 'Gérant', email: 'admin@test.lu', password: 'secret123', company: 'Garage Test' }));
  await call('PUT', '/settings', { company: { name: 'Garage Test', iban: 'LU28 0019 4006 4475 0000', bic: 'BCEELULL' } });

  // Mécanicien avec PIN
  const { id: mechId } = await call('POST', '/users', { name: 'Paulo', role: 'mechanic', pin: '1234', color: '#f00' });

  // Fournisseur + article + achat
  const { id: supId } = await call('POST', '/suppliers', { name: 'Pièces Lux SA', iban: 'LU120010001234567891' });
  const { id: prodId } = await call('POST', '/products', { ref: 'FH-001', name: 'Filtre à huile', purchase_price: 5, sale_price: 12, qty_min: 2, supplier_id: supId });
  const { id: purId } = await call('POST', '/purchases', { supplier_id: supId, supplier_ref: 'FA-778', lines: [{ product_id: prodId, description: 'Filtre à huile', quantity: 10, unit_price: 5, tax_rate: 17 }] });
  await call('POST', `/purchases/${purId}/receive`);
  let prod = await call('GET', `/products/${prodId}`);
  assert.equal(prod.qty_on_hand, 10);
  await call('POST', `/purchases/${purId}/post`);
  const pur = await call('GET', `/purchases/${purId}`);
  assert.equal(pur.total, 58.5);

  // Client + véhicule + devis -> OR
  const { id: custId } = await call('POST', '/customers', { name: 'Jean Muller', email: 'jean@test.lu' });
  const { id: vehId } = await call('POST', '/vehicles', { customer_id: custId, plate: 'ab 1234', make: 'VW', model: 'Golf', mileage: 100000 });
  const { id: quoteId } = await call('POST', '/documents', {
    type: 'quote', customer_id: custId, vehicle_id: vehId, lines: [
      { kind: 'labor', description: 'Vidange', quantity: 1, unit_price: 85, tax_rate: 17 },
      { kind: 'part', product_id: prodId, description: 'Filtre à huile', quantity: 1, unit_price: 12, tax_rate: 17 },
    ],
  });
  let quote = await call('GET', `/documents/${quoteId}`);
  assert.equal(quote.total, 113.49);
  const { id: orderId } = await call('POST', `/documents/${quoteId}/convert`, { type: 'order' });

  // Pointage kiosque
  ({ token: kioskToken } = await call('POST', '/kiosk/login', { user_id: mechId, pin: '1234' }, null));
  await assert.rejects(call('GET', '/dashboard', undefined, kioskToken)); // le mécanicien n'a pas accès au bureau
  let st = await call('POST', '/kiosk/clock', { action: 'start', document_id: orderId }, kioskToken);
  assert.ok(st.presence && st.work);
  await call('POST', `/kiosk/orders/${orderId}`, { status: 'done', diagnosis: 'RAS' }, kioskToken);
  st = await call('POST', '/kiosk/clock', { action: 'out' }, kioskToken);
  assert.equal(st.presence, null);

  // Facture
  const { id: invId } = await call('POST', `/documents/${orderId}/convert`, { type: 'invoice' });
  const { number } = await call('POST', `/documents/${invId}/post`);
  assert.match(number, /^F\d{4}-0001$/);
  prod = await call('GET', `/products/${prodId}`);
  assert.equal(prod.qty_on_hand, 9);

  // Banque : import CAMT.053 contenant le numéro de facture -> rapprochement automatique
  const { id: bankId } = await call('POST', '/bank-accounts', { name: 'BCEE', iban: 'LU28 0019 4006 4475 0000' });
  const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
    <Acct><Id><IBAN>LU280019400644750000</IBAN></Id></Acct>
    <Ntry><Amt Ccy="EUR">113.49</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-09-20</Dt></BookgDt><AcctSvcrRef>X1</AcctSvcrRef>
      <NtryDtls><TxDtls><RltdPties><Dbtr><Nm>MULLER JEAN</Nm></Dbtr></RltdPties><RmtInf><Ustrd>Facture ${number}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
    <Ntry><Amt Ccy="EUR">58.50</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-09-21</Dt></BookgDt><AcctSvcrRef>X2</AcctSvcrRef>
      <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Pieces Lux SA</Nm></Cdtr><CdtrAcct><Id><IBAN>LU120010001234567891</IBAN></Id></CdtrAcct></RltdPties><RmtInf><Ustrd>FA-778</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
    <Ntry><Amt Ccy="EUR">4.50</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-09-22</Dt></BookgDt><AcctSvcrRef>X3</AcctSvcrRef><AddtlNtryInf>Frais de tenue de compte</AddtlNtryInf></Ntry>
  </Stmt></BkToCstmrStmt></Document>`;
  const imp = await call('POST', `/bank/import/${bankId}`, camt);
  assert.equal(imp.added, 3);
  assert.equal(imp.matched, 2);
  const again = await call('POST', `/bank/import/${bankId}`, camt);
  assert.equal(again.added, 0); // pas de doublons
  const lines = await call('GET', '/bank/lines?status=unmatched');
  assert.equal(lines.length, 1);
  await call('POST', `/bank/lines/${lines[0].id}/assign`, { account_code: '6181' });

  const inv = await call('GET', `/documents/${invId}`);
  assert.equal(inv.status, 'paid');
  assert.equal((await call('GET', `/purchases/${purId}`)).status, 'paid');

  // Comptabilité équilibrée + TVA
  const bal = await call('GET', '/accounting/balance?from=2000-01-01&to=2099-12-31');
  const d = bal.reduce((s, r) => s + r.debit, 0), c = bal.reduce((s, r) => s + r.credit, 0);
  assert.ok(Math.abs(d - c) < 0.001);
  const vat = await call('GET', '/accounting/vat?from=2000-01-01&to=2099-12-31');
  assert.equal(vat.totalCollected, 16.49);
  assert.equal(vat.totalDeductible, 8.5);
  assert.equal(vat.due, 7.99);

  // Note de crédit
  const { id: cnId } = await call('POST', `/documents/${invId}/convert`, { type: 'credit_note' });
  await call('POST', `/documents/${cnId}/post`);
  prod = await call('GET', `/products/${prodId}`);
  assert.equal(prod.qty_on_hand, 10);

  // Agents (mode démo sans clé)
  const agents = await call('GET', '/agents');
  assert.equal(agents.length, 6);
  const { id: taskId } = await call('POST', '/agent-tasks', { agent_id: 'comptable', title: 'Point trésorerie', prompt: 'Fais le point', schedule_type: 'weekly', schedule_time: '08:00', schedule_day: 1 });
  const task = (await call('GET', '/agent-tasks')).find((t) => t.id === taskId);
  assert.ok(task.next_run);
  const dash = await call('GET', '/dashboard');
  assert.equal(dash.ordersOpen, 0);
});
