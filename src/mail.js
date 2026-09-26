// E-mails (modèles, envoi immédiat ou programmé), historique des échanges ("chatter") et activités planifiées
// sur chaque fiche, comme dans Odoo.
import nodemailer from 'nodemailer';
import QRCode from 'qrcode';
import { db, all, get, run, insert, getSettings, setSetting, round2, localDateTime, today } from './db.js';
import { logoFile } from './branding.js';
import { getDocument, getPurchase, BusinessError } from './business.js';

db.exec(`
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY, model TEXT, record_id INTEGER, to_addr TEXT NOT NULL, cc TEXT, subject TEXT NOT NULL,
  intro TEXT, include_document INTEGER DEFAULT 1, status TEXT DEFAULT 'scheduled', scheduled_at TEXT, sent_at TEXT,
  error TEXT, user_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status, scheduled_at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, model TEXT NOT NULL, record_id INTEGER NOT NULL, kind TEXT DEFAULT 'note', body TEXT,
  email_id INTEGER, user_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_rec ON messages(model, record_id);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY, model TEXT, record_id INTEGER, module TEXT DEFAULT 'general', type TEXT DEFAULT 'todo',
  summary TEXT NOT NULL, note TEXT, due_date TEXT NOT NULL, due_time TEXT, user_id INTEGER REFERENCES users(id),
  status TEXT DEFAULT 'planned', done_at TEXT, feedback TEXT, recurrence TEXT DEFAULT 'none',
  created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_activities_due ON activities(status, due_date);
`);

export const MODELS = ['document', 'customer', 'vehicle', 'purchase', 'product', 'supplier', 'appointment', 'lead'];
export const MODULES = {
  general: 'Général', atelier: 'Atelier', planning: 'Planning', ventes: 'Ventes', clients: 'Clients', vehicules: 'Véhicules',
  stock: 'Stock', achats: 'Achats', banque: 'Banque', comptabilite: 'Comptabilité', pointage: 'Pointage', ia: 'Bureau IA', crm: 'CRM', marketing: 'Marketing',
};
export const ACTIVITY_TYPES = { todo: 'À faire', call: 'Appel', email: 'E-mail', meeting: 'Rendez-vous', reminder: 'Rappel', payment: 'Relance paiement', order: 'Commande' };
const MODEL_MODULE = { document: 'ventes', customer: 'clients', vehicle: 'vehicules', purchase: 'achats', product: 'stock', supplier: 'achats', appointment: 'planning', lead: 'crm' };

// ---------- Configuration SMTP ----------
export function mailConfig() { return getSettings().smtp || {}; }
export function publicMailConfig() { const { pass, ...c } = mailConfig(); return { ...c, has_pass: Boolean(pass), configured: isConfigured() }; }
export function saveMailConfig(c) {
  const cur = mailConfig();
  setSetting('smtp', {
    host: (c.host ?? cur.host ?? '').trim(), port: Number(c.port ?? cur.port ?? 587), secure: Boolean(c.secure ?? cur.secure),
    user: (c.user ?? cur.user ?? '').trim(), pass: c.pass ? c.pass : cur.pass, from_name: c.from_name ?? cur.from_name ?? '',
    from_email: (c.from_email ?? cur.from_email ?? '').trim(), bcc_me: Boolean(c.bcc_me ?? cur.bcc_me), signature: c.signature ?? cur.signature ?? '',
  });
}
export const isMailConfigured = () => isConfigured();
const isConfigured = () => process.env.MAIL_TRANSPORT === 'json' || Boolean(mailConfig().host && mailConfig().from_email);
function transport() {
  if (process.env.MAIL_TRANSPORT === 'json') return nodemailer.createTransport({ jsonTransport: true });
  const c = mailConfig();
  return nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure || Number(c.port) === 465, auth: c.user ? { user: c.user, pass: c.pass } : undefined, connectionTimeout: 15000 });
}
export async function testMail() {
  if (!isConfigured()) throw new BusinessError('Renseignez le serveur SMTP et l\'adresse d\'expédition.');
  try { await transport().verify(); } catch (e) { throw new BusinessError(`Connexion SMTP impossible : ${e.message}`); }
  return { ok: true };
}

// ---------- Fiches liées ----------
export function recordInfo(model, id) {
  if (!model || !id) return null;
  const r = {
    document: () => { const d = get(`SELECT d.type, d.number, d.customer_id, c.name, c.email FROM documents d LEFT JOIN customers c ON c.id=d.customer_id WHERE d.id=?`, id); return d && { label: `${{ quote: 'Devis', order: 'OR', invoice: 'Facture', credit_note: 'Avoir' }[d.type]} ${d.number || 'brouillon'} — ${d.name || ''}`, link: `/document/${id}`, email: d.email, name: d.name, doc_type: d.type }; },
    customer: () => { const c = get('SELECT name, email FROM customers WHERE id=?', id); return c && { label: c.name, link: `/customer/${id}`, email: c.email, name: c.name }; },
    vehicle: () => { const v = get('SELECT v.plate, v.make, v.model, c.name, c.email FROM vehicles v LEFT JOIN customers c ON c.id=v.customer_id WHERE v.id=?', id); return v && { label: `${v.plate || ''} ${v.make || ''} ${v.model || ''}`.trim(), link: `/vehicle/${id}`, email: v.email, name: v.name }; },
    purchase: () => { const p = get('SELECT p.number, s.name, s.email FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=?', id); return p && { label: `Achat ${p.number} — ${p.name || ''}`, link: `/purchase/${id}`, email: p.email, name: p.name }; },
    product: () => { const p = get('SELECT ref, name FROM products WHERE id=?', id); return p && { label: `${p.ref ? p.ref + ' — ' : ''}${p.name}`, link: `/product/${id}` }; },
    supplier: () => { const s = get('SELECT name, email FROM suppliers WHERE id=?', id); return s && { label: s.name, link: '/suppliers', email: s.email, name: s.name }; },
    lead: () => { const l = get('SELECT name, contact_name, email FROM crm_leads WHERE id=?', id); return l && { label: `Opportunité : ${l.name}`, link: `/crm?lead=${id}`, email: l.email, name: l.contact_name }; },
    appointment: () => { const a = get('SELECT a.start, a.title, c.name, c.email FROM appointments a LEFT JOIN customers c ON c.id=a.customer_id WHERE a.id=?', id); return a && { label: `RDV ${a.start.slice(0, 16).replace('T', ' ')} — ${a.name || ''}`, link: '/planning', email: a.email, name: a.name }; },
  }[model];
  return r ? r() : null;
}

// ---------- Modèles d'e-mails ----------
const fmt = (v) => new Intl.NumberFormat('fr-LU', { style: 'currency', currency: 'EUR' }).format(Number(v) || 0);
const fdate = (d) => (d ? new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('fr-LU') : '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function templatesFor(model, id) {
  if (model === 'document') {
    const t = get('SELECT type, status FROM documents WHERE id=?', id)?.type;
    return { quote: ['quote', 'generic'], order: ['live_tracking', 'order_received', 'order_ready', 'generic'], invoice: ['invoice', 'invoice_reminder', 'generic'], credit_note: ['credit_note', 'generic'] }[t] || ['generic'];
  }
  return { appointment: ['appointment_confirm', 'generic'], customer: ['generic', 'overdue'], vehicle: ['ct_reminder', 'service_reminder', 'generic'], purchase: ['purchase_order', 'generic'] }[model] || ['generic'];
}
export const TEMPLATE_LABELS = {
  generic: 'Message libre', live_tracking: 'Lien de suivi en direct', quote: 'Envoi du devis', order_received: 'Prise en charge du véhicule', order_ready: 'Véhicule prêt',
  invoice: 'Envoi de la facture', invoice_reminder: 'Relance de paiement', credit_note: 'Envoi de la note de crédit', overdue: 'Relevé des impayés',
  ct_reminder: 'Rappel contrôle technique', appointment_confirm: 'Confirmation de rendez-vous', service_reminder: 'Rappel entretien', purchase_order: 'Bon de commande fournisseur',
};

export function compose(model, id, template, base = '') {
  const s = getSettings();
  const garage = s.company.name;
  const info = recordInfo(model, id) || {};
  template ||= templatesFor(model, id)[0];
  const hello = info.name ? `Bonjour ${info.name},` : 'Bonjour,';
  let subject = garage, intro = `${hello}\n\n`, include = false;
  if (model === 'document') {
    const d = get('SELECT d.*, v.plate, v.make, v.model FROM documents d LEFT JOIN vehicles v ON v.id=d.vehicle_id WHERE d.id=?', id);
    const veh = d.plate ? ` (${d.plate})` : '';
    include = true;
    switch (template) {
      case 'quote': subject = `Devis ${d.number} — ${garage}`; intro += `Veuillez trouver ci-dessous notre devis ${d.number} pour votre véhicule${veh}, d'un montant de ${fmt(d.total)} TTC.\n\nPour l'accepter, il vous suffit de répondre à cet e-mail ou de nous appeler.`; break;
      case 'live_tracking': {
        const t = get("SELECT token FROM order_links WHERE document_id=? AND role='customer' AND revoked=0", id)?.token;
        subject = `Suivez la réparation de votre véhicule${veh} en direct`;
        intro += `Votre véhicule${veh} est entre nos mains. Suivez l'avancement des travaux en temps réel, recevez photos et vidéos de notre atelier et validez d'un clic les éventuels travaux supplémentaires :\n\n${t ? `${base}/suivi.html?t=${t}` : '(lien à créer depuis l’OR)'}`;
        include = false;
        break;
      }
      case 'order_received': subject = `Prise en charge de votre véhicule${veh}`; intro += `Nous avons bien pris en charge votre véhicule${veh}.${d.promised_at ? `\nIl devrait être prêt le ${fdate(d.promised_at)} vers ${d.promised_at.slice(11, 16)}.` : ''}\n\nNous vous contacterons en cas de travaux supplémentaires.`; break;
      case 'order_ready': subject = `Votre véhicule${veh} est prêt`; intro += `Bonne nouvelle : votre véhicule${veh} est prêt ! Vous pouvez venir le récupérer aux heures d'ouverture.`; include = false; break;
      case 'invoice': subject = `Facture ${d.number} — ${garage}`; intro += `Veuillez trouver ci-dessous votre facture ${d.number} d'un montant de ${fmt(d.total)} TTC, payable avant le ${fdate(d.due_date)}.\n\nMerci pour votre confiance.`; break;
      case 'invoice_reminder': subject = `Rappel : facture ${d.number} en attente de paiement`; intro += `Sauf erreur de notre part, la facture ${d.number} du ${fdate(d.date)} (échéance ${fdate(d.due_date)}) reste impayée pour un montant de ${fmt(d.total - d.amount_paid)}.\n\nNous vous remercions de bien vouloir procéder au règlement dans les meilleurs délais. Si le paiement a été effectué entre-temps, merci de ne pas tenir compte de ce message.`; break;
      case 'credit_note': subject = `Note de crédit ${d.number} — ${garage}`; intro += `Veuillez trouver ci-dessous la note de crédit ${d.number} d'un montant de ${fmt(d.total)}.`; break;
      default: subject = `${info.label || garage}`; include = false;
    }
  } else if (model === 'customer' && template === 'overdue') {
    subject = `Relevé de vos factures en attente — ${garage}`;
    intro += 'Sauf erreur de notre part, les factures ci-dessous restent en attente de paiement. Nous vous remercions de bien vouloir les régler dans les meilleurs délais.';
    include = true;
  } else if (model === 'vehicle' && (template === 'ct_reminder' || template === 'service_reminder')) {
    const v = get('SELECT * FROM vehicles WHERE id=?', id);
    const ct = template === 'ct_reminder';
    subject = ct ? `Contrôle technique de votre ${v.make || 'véhicule'} ${v.plate || ''}`.trim() : `Entretien de votre ${v.make || 'véhicule'} ${v.plate || ''}`.trim();
    intro += ct
      ? `Le contrôle technique de votre véhicule ${v.plate || ''} arrive à échéance${v.next_inspection ? ` le ${fdate(v.next_inspection)}` : ''}.\n\nNous pouvons préparer votre véhicule avant le passage au contrôle (freins, éclairage, pneus…). Répondez simplement à cet e-mail pour prendre rendez-vous.`
      : `L'entretien de votre véhicule ${v.plate || ''} est bientôt dû${v.next_service_date ? ` (${fdate(v.next_service_date)})` : ''}.\n\nRépondez à cet e-mail ou appelez-nous pour fixer un rendez-vous.`;
  } else if (model === 'appointment' && template === 'appointment_confirm') {
    const a = get('SELECT a.*, v.plate FROM appointments a LEFT JOIN vehicles v ON v.id=a.vehicle_id WHERE a.id=?', id);
    subject = `Confirmation de votre rendez-vous du ${fdate(a.start.slice(0, 10))} — ${garage}`;
    intro += `Nous vous confirmons votre rendez-vous le ${fdate(a.start.slice(0, 10))} à ${a.start.slice(11, 16)}${a.plate ? ` pour votre véhicule ${a.plate}` : ''}${a.title ? ` (${a.title})` : ''}.\n\nEn cas d'empêchement, merci de nous prévenir.`;
  } else if (model === 'purchase' && template === 'purchase_order') {
    const p = get('SELECT number FROM purchases WHERE id=?', id);
    subject = `Commande ${p.number} — ${garage}`;
    intro += `Merci de bien vouloir nous livrer les articles ci-dessous (commande ${p.number}) et de nous confirmer le délai de livraison.`;
    include = true;
  } else {
    subject = info.label ? `${info.label} — ${garage}` : garage;
  }
  return { to: info.email || '', subject, intro: `${intro}\n\nCordialement,\n${mailConfig().signature || garage}`, include_document: include, template, templates: templatesFor(model, id).map((k) => ({ key: k, label: TEMPLATE_LABELS[k] })) };
}

function table(rows, head) {
  const th = head.map((h, i) => `<th style="text-align:${i ? 'right' : 'left'};padding:6px 8px;background:#f3f4f6;font-size:12px">${h}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${i ? 'right' : 'left'};padding:6px 8px;border-bottom:1px solid #eee;font-size:13px">${c}</td>`).join('')}</tr>`).join('');
  return `<table style="width:100%;border-collapse:collapse;margin:12px 0">${th ? `<tr>${th}</tr>` : ''}${tr}</table>`;
}

async function documentBlock(model, id, attachments) {
  const s = getSettings();
  if (model === 'document') {
    const d = getDocument(id);
    const titles = { quote: 'Devis', order: 'Ordre de réparation', invoice: 'Facture', credit_note: 'Note de crédit' };
    let html = `<h3 style="margin:18px 0 4px">${titles[d.type]} ${esc(d.number || '')}</h3><div style="color:#555;font-size:13px">Date : ${fdate(d.date)}${d.plate ? ` · Véhicule : ${esc(d.plate)} ${esc(d.make || '')} ${esc(d.model || '')}` : ''}${d.mileage ? ` · ${d.mileage} km` : ''}</div>`;
    html += table(d.lines.map((l) => (l.kind === 'text' ? [`<i>${esc(l.description)}</i>`, '', '', ''] : [esc(l.description), l.quantity, fmt(l.unit_price), fmt(l.total_ht)])), ['Désignation', 'Qté', 'P.U. HT', 'Total HT']);
    html += table([['Total HT', fmt(d.subtotal)], ...d.taxes.map((t) => [`TVA ${t.rate} %`, fmt(t.amount)]), [`<b>Total TTC</b>`, `<b>${fmt(d.total)}</b>`]], []);
    const residual = round2(d.total - d.amount_paid);
    if (d.type === 'invoice' && residual > 0 && s.company.iban) {
      const payload = ['BCD', '002', '1', 'SCT', s.company.bic || '', (s.company.name || '').slice(0, 70), s.company.iban.replace(/\s/g, ''), `EUR${residual.toFixed(2)}`, '', '', d.number || '', ''].join('\n');
      attachments.push({ filename: 'paiement.png', content: await QRCode.toBuffer(payload, { margin: 1, width: 220 }), cid: 'qrpay' });
      html += `<table style="margin-top:8px"><tr><td><img src="cid:qrpay" width="130" height="130" alt="QR"></td><td style="padding-left:12px;font-size:13px">
        <b>Paiement : ${fmt(residual)}</b><br>IBAN ${esc(s.company.iban)}<br>BIC ${esc(s.company.bic || '')}<br>Communication : <b>${esc(d.number)}</b><br><span style="color:#777">Scannez le QR code avec votre application bancaire.</span></td></tr></table>`;
    }
    return html;
  }
  if (model === 'purchase') {
    const p = getPurchase(id);
    return `<h3 style="margin:18px 0 4px">Commande ${esc(p.number)}</h3>` + table(p.lines.map((l) => [esc(l.description), l.quantity]), ['Article', 'Quantité']);
  }
  if (model === 'customer') {
    const rows = all(`SELECT number, date, due_date, total, amount_paid FROM documents WHERE customer_id=? AND type='invoice' AND status IN ('posted','partial') ORDER BY date`, id);
    if (!rows.length) return '';
    const tot = rows.reduce((a, r) => a + r.total - r.amount_paid, 0);
    return table([...rows.map((r) => [esc(r.number), fdate(r.date), fdate(r.due_date), fmt(r.total - r.amount_paid)]), ['<b>Total</b>', '', '', `<b>${fmt(tot)}</b>`]], ['Facture', 'Date', 'Échéance', 'Reste dû']);
  }
  return '';
}

export async function renderEmail({ model, record_id, intro, include_document }) {
  const s = getSettings();
  const attachments = [];
  const block = include_document ? await documentBlock(model, record_id, attachments) : '';
  const c = s.company;
  const L = s.layout || {};
  const logo = L.show_logo !== false ? logoFile() : null;
  if (logo) attachments.push({ filename: 'logo.' + logo.ext, path: logo.file, cid: 'garagelogo' });
  const accent = /^#[0-9a-f]{6}$/i.test(L.primary || '') ? L.primary : '#2563eb';
  const head = `<div style="border-bottom:3px solid ${accent};padding-bottom:10px;margin-bottom:16px">${logo ? `<img src="cid:garagelogo" alt="${esc(c.name)}" style="max-height:56px;max-width:220px">` : `<b style="font-size:18px;color:${accent}">${esc(c.name)}</b>`}${L.tagline ? `<div style="font-size:12px;color:#666;margin-top:4px">${esc(L.tagline)}</div>` : ''}</div>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:640px">${head}
    <div style="font-size:14px;line-height:1.55">${esc(intro).replace(/\n/g, '<br>')}</div>${block}
    <hr style="border:0;border-top:1px solid #ddd;margin:24px 0 10px">
    <div style="font-size:11px;color:#777">${esc(c.name)} · ${esc([c.address, [c.zip, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', '))}${c.phone ? ` · ${esc(c.phone)}` : ''}${c.vat_number && c.vat_number !== 'LU' ? ` · TVA ${esc(c.vat_number)}` : ''}</div></div>`;
  return { html, attachments, text: intro };
}

// ---------- Envoi ----------
export function logMessage(model, record_id, body, user_id = null, kind = 'note', email_id = null) {
  if (!model || !record_id) return;
  insert('messages', { model, record_id, body, user_id, kind, email_id }, ['model', 'record_id', 'body', 'user_id', 'kind', 'email_id']);
}

async function deliver(email) {
  const c = mailConfig();
  const { html, attachments, text } = await renderEmail({ model: email.model, record_id: email.record_id, intro: email.intro, include_document: email.include_document });
  const me = email.user_id ? get('SELECT email FROM users WHERE id=?', email.user_id)?.email : null;
  const from = c.from_email ? (c.from_name ? `"${c.from_name.replace(/"/g, '')}" <${c.from_email}>` : c.from_email) : 'garage@localhost';
  await transport().sendMail({ from, to: email.to_addr, cc: email.cc || undefined, bcc: c.bcc_me && me ? me : undefined, replyTo: c.from_email || undefined, subject: email.subject, html, text, attachments });
  run("UPDATE emails SET status='sent', sent_at=?, error=NULL WHERE id=?", localDateTime(), email.id);
  logMessage(email.model, email.record_id, `✉️ E-mail envoyé à ${email.to_addr} : « ${email.subject} »`, email.user_id, 'email', email.id);
}

export async function sendEmail({ model, record_id, to, cc, subject, intro, include_document, scheduled_at, user_id }) {
  if (!to || !/@/.test(to)) throw new BusinessError('Adresse e-mail du destinataire manquante');
  if (!subject) throw new BusinessError('Objet manquant');
  if (!isConfigured()) throw new BusinessError('Configurez d\'abord l\'envoi d\'e-mails dans Paramètres → E-mails.');
  const later = scheduled_at && new Date(scheduled_at) > new Date(Date.now() + 30_000);
  const id = insert('emails', { model, record_id, to_addr: to, cc, subject, intro, include_document: include_document ? 1 : 0, status: later ? 'scheduled' : 'sending', scheduled_at: later ? scheduled_at : null, user_id },
    ['model', 'record_id', 'to_addr', 'cc', 'subject', 'intro', 'include_document', 'status', 'scheduled_at', 'user_id']);
  if (later) {
    logMessage(model, record_id, `🕒 E-mail programmé pour le ${scheduled_at.replace('T', ' à ').slice(0, 19)} : « ${subject} » (${to})`, user_id, 'email', id);
    return { id, status: 'scheduled' };
  }
  try {
    await deliver(get('SELECT * FROM emails WHERE id=?', id));
  } catch (e) {
    run("UPDATE emails SET status='error', error=? WHERE id=?", e.message, id);
    throw new BusinessError(`Envoi impossible : ${e.message}`);
  }
  if (model === 'document') {
    const d = get('SELECT type, status FROM documents WHERE id=?', record_id);
    if (d?.type === 'quote' && d.status === 'draft') run("UPDATE documents SET status='sent' WHERE id=?", record_id);
  }
  return { id, status: 'sent' };
}

export async function processScheduledEmails() {
  const due = all("SELECT * FROM emails WHERE status='scheduled' AND scheduled_at<=?", localDateTime());
  for (const e of due) {
    run("UPDATE emails SET status='sending' WHERE id=?", e.id);
    try { await deliver(e); } catch (err) {
      run("UPDATE emails SET status='error', error=? WHERE id=?", err.message, e.id);
      logMessage(e.model, e.record_id, `⚠️ Échec de l'envoi programmé « ${e.subject} » : ${err.message}`, e.user_id, 'system');
    }
  }
}

// ---------- Activités ----------
export const ACTIVITY_COLS = ['model', 'record_id', 'module', 'type', 'summary', 'note', 'due_date', 'due_time', 'user_id', 'recurrence', 'created_by'];

export function listActivities({ user_id, module, model, record_id, status = 'planned', scope } = {}) {
  const w = ['a.status=?'];
  const p = [status];
  if (user_id) { w.push('a.user_id=?'); p.push(user_id); }
  if (module) { w.push('a.module=?'); p.push(module); }
  if (model) { w.push('a.model=? AND a.record_id=?'); p.push(model, record_id); }
  if (scope === 'late') { w.push('a.due_date<?'); p.push(today()); }
  if (scope === 'today') { w.push('a.due_date=?'); p.push(today()); }
  if (scope === 'upcoming') { w.push('a.due_date>?'); p.push(today()); }
  const rows = all(`SELECT a.*, u.name AS user_name, u.color AS user_color, c.name AS creator_name FROM activities a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN users c ON c.id=a.created_by
    WHERE ${w.join(' AND ')} ORDER BY a.due_date, a.due_time, a.id LIMIT 500`, ...p);
  for (const r of rows) r.record = recordInfo(r.model, r.record_id);
  return rows;
}

export function createActivity(data, userId) {
  if (!data.summary?.trim()) throw new BusinessError('Résumé requis');
  if (!data.due_date) throw new BusinessError('Date d\'échéance requise');
  const module = data.module || MODEL_MODULE[data.model] || 'general';
  const id = insert('activities', { ...data, module, user_id: data.user_id || userId, created_by: userId, recurrence: data.recurrence || 'none' }, ACTIVITY_COLS);
  logMessage(data.model, data.record_id, `📌 Activité planifiée : ${ACTIVITY_TYPES[data.type] || ''} « ${data.summary} » pour le ${fdate(data.due_date)}`, userId, 'system');
  return id;
}

function nextDate(date, rec) {
  const d = new Date(date + 'T12:00:00');
  if (rec === 'daily') d.setDate(d.getDate() + 1);
  else if (rec === 'weekly') d.setDate(d.getDate() + 7);
  else if (rec === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (rec === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else return null;
  return d.toISOString().slice(0, 10);
}

export function completeActivity(id, feedback, userId) {
  const a = get('SELECT * FROM activities WHERE id=?', id);
  if (!a || a.status !== 'planned') throw new BusinessError('Activité introuvable ou déjà terminée');
  run("UPDATE activities SET status='done', done_at=?, feedback=? WHERE id=?", localDateTime(), feedback || null, id);
  logMessage(a.model, a.record_id, `✅ Activité terminée : « ${a.summary} »${feedback ? ` — ${feedback}` : ''}`, userId, 'system');
  const next = nextDate(a.due_date, a.recurrence);
  if (next) {
    const { id: _, status, done_at, feedback: f, created_at, ...rest } = a;
    insert('activities', { ...rest, due_date: next }, ACTIVITY_COLS);
  }
  return { next };
}

export function activityCounts(userId) {
  const t = today();
  const r = get(`SELECT SUM(due_date<?) AS late, SUM(due_date=?) AS today, SUM(due_date>?) AS upcoming FROM activities WHERE status='planned' AND user_id=?`, t, t, t, userId);
  return { late: r.late || 0, today: r.today || 0, upcoming: r.upcoming || 0 };
}

export function chatter(model, record_id) {
  return {
    messages: all(`SELECT m.*, u.name AS user_name, u.color AS user_color, e.status AS email_status, e.error AS email_error, e.scheduled_at
      FROM messages m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN emails e ON e.id=m.email_id WHERE m.model=? AND m.record_id=? ORDER BY m.id DESC LIMIT 200`, model, record_id),
    activities: listActivities({ model, record_id }),
    scheduled: all("SELECT id, to_addr, subject, scheduled_at FROM emails WHERE model=? AND record_id=? AND status='scheduled' ORDER BY scheduled_at", model, record_id),
  };
}
