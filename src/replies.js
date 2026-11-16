// Conversation par e-mail avec le client, gardée dans la fiche (comme le « chatter » d'Odoo).
// Le logiciel relève la boîte de réception du garage (IMAP, en lecture seule : rien n'y est marqué lu ni déplacé) et range
// chaque réponse dans la fiche du message auquel elle répond. Les e-mails qui ne répondent à aucun envoi du logiciel
// sont laissés de côté : ils ne sont ni lus par l'IA, ni enregistrés.
import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db, all, get, run, insert, getSettings, setSetting, localDateTime, today } from './db.js';
import { BusinessError } from './business.js';
import { createActivity, recordInfo, mailConfig } from './mail.js';
import { saveAttachment } from './bills.js';

db.exec(`
CREATE TABLE IF NOT EXISTS mail_seen (
  message_id TEXT PRIMARY KEY, seen_at TEXT DEFAULT CURRENT_TIMESTAMP, matched INTEGER DEFAULT 0
);
`);

const MAX_TEXT = 6000;    // texte montré dans la fiche
const MAX_FULL = 20000;   // message complet (avec la partie citée), gardé à part
const MAX_INPUT = 200000; // au-delà, le reste du texte d'un e-mail n'est pas analysé
const MAX_HTML = 200000;
const MAX_FILE = 15 * 1024 * 1024;
const MAX_FILES = 10;
// pièces jointes gardées : celles qu'on peut ouvrir sans risque (pas de programme, pas de page web)
const FILE_TYPES = /^(application\/pdf|image\/(jpeg|png|webp|gif|heic)|text\/plain|application\/(msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-excel|zip))$/i;

// ---------- Réglages de la boîte de réception ----------
export function repliesConfig() { return getSettings().replies_inbox || {}; }
export function publicRepliesConfig() {
  const { pass, ...c } = repliesConfig();
  return { port: 993, secure: true, folder: 'INBOX', interval: 5, same_login: true, ...c, has_pass: Boolean(pass), status: getSettings().replies_inbox_status || null, shared_with: sharedWith() };
}
/**
 * La boîte des réponses est-elle aussi celle d'une autre réception du logiciel ? Celles-ci marquent les e-mails comme lus
 * (et peuvent les déplacer) : les réponses des clients risqueraient de ne jamais arriver dans leurs fiches.
 */
function sharedWith() {
  const c = repliesConfig(), st = getSettings();
  const user = c.same_login !== false ? st.smtp?.user || c.user : c.user;
  if (!c.host || !user) return null;
  const key = (o, u) => [o?.host, u, o?.folder || 'INBOX'].map((x) => String(x || '').trim().toLowerCase()).join('|');
  const mine = key(c, user);
  if (st.bills_inbox?.host && key(st.bills_inbox, st.bills_inbox.user) === mine) return 'bills';
  if (st.archive_inbox?.host && key(st.archive_inbox, st.archive_inbox.user) === mine) return 'archives';
  return null;
}
export function saveRepliesConfig(c) {
  const cur = repliesConfig();
  const b = c && typeof c === 'object' ? c : {};
  setSetting('replies_inbox', {
    enabled: Boolean(b.enabled ?? cur.enabled), host: String(b.host ?? cur.host ?? '').trim(), port: Number(b.port ?? cur.port ?? 993) || 993,
    secure: b.secure ?? cur.secure ?? true, same_login: Boolean(b.same_login ?? cur.same_login ?? true),
    user: String(b.user ?? cur.user ?? '').trim(), pass: b.pass ? String(b.pass) : cur.pass,
    folder: String(b.folder ?? cur.folder ?? 'INBOX').trim() || 'INBOX', interval: Math.min(120, Math.max(1, Number(b.interval ?? cur.interval ?? 5) || 5)),
  });
}
/** Identifiants de connexion : ceux de la boîte, ou — par défaut — les mêmes que pour l'envoi. */
function credentials() {
  const c = repliesConfig(), s = mailConfig();
  const user = c.same_login !== false ? s.user || c.user : c.user;
  const pass = c.same_login !== false ? s.pass || c.pass : c.pass;
  if (!c.host || !user || !pass) throw new BusinessError('Renseignez le serveur de réception (IMAP), l’identifiant et le mot de passe dans Paramètres → E-mails.');
  return { host: c.host, port: c.port || 993, secure: c.secure !== false, user, pass, folder: c.folder || 'INBOX' };
}
function client(c) {
  const cl = new ImapFlow({ host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass }, logger: false, socketTimeout: 60000 });
  // Sans écouteur, une coupure de connexion (événement « error ») arrêterait tout le logiciel : la commande en cours
  // échoue d'elle-même et la relève se termine avec un message d'erreur.
  cl.on('error', () => {});
  return cl;
}
export async function testReplies() {
  const c = credentials();
  const cl = client(c);
  try {
    await cl.connect();
    const st = await cl.status(c.folder, { messages: true });
    return { messages: st.messages };
  } catch (e) {
    throw new BusinessError(`Connexion à la boîte de réception impossible : ${e.responseText || e.message}`);
  } finally { await cl.logout().catch(() => {}); }
}

// ---------- Une réponse reçue ----------
const normId = (s) => { const m = /<[^<>\s]+>/.exec(String(s || '')); return m ? m[0] : null; };
const idsOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/\s+/)).map(normId).filter(Boolean);
// (les textes venus d'un e-mail sont toujours raccourcis avant d'être analysés : un message piégé ne doit pas occuper le logiciel)
const addrOf = (s) => (/[^\s<>,;@]+@[^\s<>,;@]+/.exec(String(s || '').slice(0, 320).toLowerCase()) || [''])[0];

/** La fiche à laquelle un e-mail reçu répond (null s'il ne répond à aucun envoi du logiciel). */
function matchRecord(mail, sender) {
  // 1. la réponse cite l'identifiant du message auquel elle répond (ou d'un message plus ancien de la même conversation)
  for (const id of [...idsOf(mail.inReplyTo), ...idsOf(mail.references).reverse()]) {
    const hit = get('SELECT model, record_id FROM emails WHERE message_id=? AND model IS NOT NULL AND record_id IS NOT NULL', id)
      || get('SELECT model, record_id FROM messages WHERE message_id=?', id);
    if (hit && recordInfo(hit.model, hit.record_id)) return { model: hit.model, record_id: hit.record_id };
  }
  // 2. à défaut (messagerie qui retire les références) : le numéro d'un document dans l'objet, écrit par quelqu'un à qui
  //    ce document a été envoyé — ou par le client du document
  for (const number of new Set(String(mail.subject || '').slice(0, 300).match(/[\p{L}\d._/-]{0,24}\d{4}-\d{3,6}/gu) || [])) {
    const d = get('SELECT d.id, c.email FROM documents d LEFT JOIN customers c ON c.id=d.customer_id WHERE d.number=?', number);
    if (!d || !sender) continue;
    const known = addrOf(d.email) === sender || all("SELECT to_addr, cc FROM emails WHERE model='document' AND record_id=? AND status='sent'", d.id)
      .some((e) => `${e.to_addr || ''},${e.cc || ''}`.toLowerCase().split(/[,;\s]+/).map(addrOf).includes(sender));
    if (known) return { model: 'document', record_id: d.id };
  }
  return null;
}

/**
 * Le texte écrit par le client, sans la copie du message auquel il répond. Quand le client a répondu DANS le message
 * cité (ou en dessous), rien n'est retiré. Le texte complet est de toute façon gardé à part (voir processReply).
 */
export function cleanReply(text) {
  const full = String(text || '').replace(/\r\n?/g, '\n');
  const lines = full.split('\n');
  const quoted = (l) => /^>/.test(l.trim());
  let style = null; // 'mark' : la suite est citée ligne à ligne avec « > » ; 'block' : toute la suite est l'ancien message
  let skip = 1;
  const stop = lines.findIndex((l, i) => {
    const t = l.trim().slice(0, 400);
    if (/^-{2,}\s*(Original Message|Message d['’]origine|Ursprüngliche Nachricht|Mensagem original|Forwarded message)/i.test(t)) { style = 'block'; return true; }
    // « Le lun. 16 nov. 2026 à 09:12, Garage <…> a écrit : », « On … wrote: », « Am … schrieb Garage <…>: » — toujours avec une date
    if (/\d/.test(t) && (/^(Le|On|El|Em)\b.{5,300}(a écrit|wrote|escreveu|escribió)\s*:\s*$/i.test(t) || /^Am\b.{5,300}\bschrieb\b.{0,120}:\s*$/i.test(t))) { style = 'mark'; return true; }
    // (sur deux lignes : « Le lun. 16 nov. 2026 à 14:02, Garage <…> » puis « a écrit : »)
    if (/\d/.test(t) && /^(Le|On|Am|Em)\b.{5,300}$/i.test(t) && /^(a écrit|wrote|schrieb|escreveu)\s*:\s*$/i.test((lines[i + 1] || '').trim())) { style = 'mark'; skip = 2; return true; }
    if (/^(De|From|Von)\s*:\s.+/i.test(t) && lines.slice(i + 1, i + 5).some((x) => /^(Envoyé|Sent|Gesendet|Date|Datum|Enviado)\s*:/i.test(x.trim()))) { style = 'block'; return true; }
    if (quoted(l) && lines.slice(i, i + 3).every((x) => quoted(x) || !x.trim())) { style = 'mark'; skip = 0; return true; }
    return false;
  });
  let kept = lines;
  if (stop !== -1) {
    // des réponses écrites entre les lignes citées, ou sous le message cité : on garde tout
    const inline = style === 'mark' && lines.slice(stop + skip).some((l) => l.trim() && !quoted(l));
    if (!inline) kept = lines.slice(0, stop);
  }
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return (out || full.trim()).slice(0, MAX_TEXT);
}
/** Texte d'un message écrit seulement en HTML (temps de calcul proportionnel à la taille, même sur un message piégé). */
function dropBlocks(html, tag) {
  const low = html.toLowerCase(), open = '<' + tag, close = '</' + tag + '>';
  let out = '', i = 0;
  for (;;) {
    const a = low.indexOf(open, i);
    if (a === -1) { out += html.slice(i); break; }
    out += html.slice(i, a) + ' ';
    const b = low.indexOf(close, a);
    if (b === -1) break;
    i = b + close.length;
  }
  return out;
}
export function stripHtml(html) {
  const h = dropBlocks(dropBlocks(String(html || '').slice(0, MAX_HTML), 'style'), 'script');
  return h.replace(/<br\s{0,5}\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^<>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ');
}

/** Personne à prévenir d'une réponse : celle qui a écrit au client en dernier sur cette fiche, sinon le gérant. */
function ownerOf(model, record_id) {
  const last = get("SELECT e.user_id FROM emails e JOIN users u ON u.id=e.user_id AND u.active=1 WHERE e.model=? AND e.record_id=? AND e.status='sent' ORDER BY e.id DESC LIMIT 1", model, record_id);
  return last?.user_id || get("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1")?.id || null;
}

/**
 * Traite un e-mail reçu (texte brut du message). S'il répond à un envoi du logiciel, il est rangé dans la fiche
 * concernée ; sinon il est seulement noté comme « déjà vu ».
 */
export async function processReply(raw) {
  const mail = await simpleParser(raw);
  const mid = normId(mail.messageId) || `<sans-id.${crypto.createHash('sha1').update(raw).digest('hex')}@local>`;
  if (get('SELECT 1 FROM mail_seen WHERE message_id=?', mid) || get('SELECT 1 FROM messages WHERE message_id=?', mid)) return { skipped: true, matched: false };
  const from = mail.from?.value?.[0] || {};
  const sender = addrOf(from.address);
  const own = addrOf(mailConfig().from_email);
  // (une copie de nos propres envois arrivée dans la boîte n'est pas une réponse)
  const target = sender && sender === own ? null : matchRecord(mail, sender);
  // (« déjà vu » est noté d'abord : le même e-mail relevé deux fois en même temps n'est rangé qu'une fois)
  if (!run('INSERT OR IGNORE INTO mail_seen(message_id, matched) VALUES(?, ?)', mid, target ? 1 : 0).changes) return { skipped: true, matched: false };
  if (!target) return { skipped: false, matched: false };
  const whole = String(mail.text || stripHtml(mail.html) || '').slice(0, MAX_INPUT).replace(/\r\n?/g, '\n').trim();
  const text = cleanReply(whole);
  // le message complet reste consultable (« Afficher le message complet ») : rien de ce que le client a écrit n'est perdu
  const full = whole.replace(/\n{3,}/g, '\n\n').slice(0, MAX_FULL);
  // (un nom d'expéditeur qui contient lui-même une adresse est ignoré : seule compte l'adresse réelle)
  const name = String(from.name || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const who = name && !name.includes('@') && name.toLowerCase() !== sender ? `${name} <${sender}>` : sender || 'expéditeur inconnu';
  const subject = String(mail.subject || '').slice(0, 1000).replace(/\s+/g, ' ').trim().slice(0, 300);
  const id = insert('messages', { model: target.model, record_id: target.record_id, kind: 'email_in', body: text || '(message sans texte)', body_full: full && full !== text ? full : null, message_id: mid, from_addr: who, subject },
    ['model', 'record_id', 'kind', 'body', 'body_full', 'message_id', 'from_addr', 'subject']);
  let files = 0;
  for (const a of mail.attachments || []) {
    if (files >= MAX_FILES) break;
    // (les petites images intégrées au texte — logos de signature — ne sont pas des pièces jointes ; une photo glissée dans le message, si)
    if ((a.related && a.content?.length < 20000) || !a.content?.length || a.content.length > MAX_FILE || !FILE_TYPES.test(a.contentType || '')) continue;
    saveAttachment(target.model, target.record_id, { buffer: a.content, mime: a.contentType, filename: String(a.filename || 'piece-jointe').replace(/[\\/\0]/g, '_').slice(0, 120), source: `email:${id}` });
    files++;
  }
  // Un rappel pour la personne qui suivait l'échange — un seul tant qu'il n'est pas traité
  const owner = ownerOf(target.model, target.record_id);
  const info = recordInfo(target.model, target.record_id) || {};
  if (owner && !get("SELECT 1 FROM activities WHERE model=? AND record_id=? AND type='email' AND status='planned' AND summary LIKE 'Réponse de %'", target.model, target.record_id)) {
    try {
      createActivity({ model: target.model, record_id: target.record_id, type: 'email', summary: `Réponse de ${name && !name.includes('@') ? name : sender} — ${String(info.label || 'fiche').split(' — ')[0]}`.slice(0, 200),
        note: text.slice(0, 400), due_date: today(), user_id: owner }, owner);
    } catch { /* le rappel est un plus : la réponse, elle, est déjà dans la fiche */ }
  }
  return { skipped: false, matched: true, model: target.model, record_id: target.record_id, message: id, files };
}

// ---------- Relève de la boîte ----------
const DAY = 86400000;
const BATCH = 150;
/**
 * Depuis quand chercher : depuis la dernière relève RÉUSSIE (moins un jour de marge), au moins 4 jours et au plus 60 —
 * après une fermeture du garage ou une panne de mot de passe, les réponses arrivées entre-temps sont retrouvées.
 * Tant qu'aucune relève n'a réussi : 14 jours.
 */
function searchSince(now = Date.now()) {
  const ok = new Date(getSettings().replies_inbox_status?.ok_at || NaN).getTime();
  const back = Number.isNaN(ok) ? 14 * DAY : Math.min(60 * DAY, Math.max(4 * DAY, now - ok + DAY));
  return new Date(now - back);
}
let checking = false;
export async function checkReplies() {
  if (checking) throw new BusinessError('La relève des réponses est déjà en cours');
  checking = true;
  const previous = getSettings().replies_inbox_status || {};
  const status = { at: localDateTime(), ok_at: previous.ok_at || null, read: 0, matched: 0, pending: 0, unreadable: 0, error: null };
  let cl = null;
  try {
    const c = credentials();
    cl = client(c);
    await cl.connect();
    // (lecture seule : aucun message n'est marqué « lu » ni déplacé — la boîte reste celle du garage)
    const lock = await cl.getMailboxLock(c.folder, { readOnly: true });
    try {
      const fresh = [];
      for await (const m of cl.fetch({ since: searchSince() }, { envelope: true, size: true, uid: true })) {
        const mid = normId(m.envelope?.messageId);
        if (mid && (get('SELECT 1 FROM mail_seen WHERE message_id=?', mid) || get('SELECT 1 FROM messages WHERE message_id=?', mid))) continue;
        if (m.size && m.size > 25 * 1024 * 1024) continue;
        fresh.push(m.uid);
      }
      if (!cl.usable) throw new Error('connexion interrompue');
      // les plus anciens d'abord ; au-delà d'un lot, la suite est relevée au passage suivant (la période cherchée ne raccourcit pas d'ici là)
      status.pending = Math.max(0, fresh.length - BATCH);
      for (const uid of fresh.slice(0, BATCH)) {
        const msg = await cl.fetchOne(String(uid), { source: true }, { uid: true });
        if (!cl.usable) throw new Error('connexion interrompue');
        if (!msg?.source) continue;
        try {
          const r = await processReply(msg.source);
          if (!r.skipped) status.read++;
          if (r.matched) status.matched++;
        } catch (e) {
          // un e-mail illisible ne bloque pas les autres (il sera retenté à la prochaine relève)
          status.unreadable++;
          console.error('Réponses par e-mail : message illisible —', e.message);
        }
      }
    } finally { lock.release(); }
  } catch (e) {
    status.error = e instanceof BusinessError ? e.message : `Connexion à la boîte de réception impossible (${e.responseText || e.message})`;
  } finally {
    checking = false;
    if (cl) await cl.logout().catch(() => {});
    if (!status.error && !status.pending && !status.unreadable) status.ok_at = status.at;
    setSetting('replies_inbox_status', status);
  }
  if (status.error) throw new BusinessError(status.error);
  return status;
}

export function startRepliesPolling() {
  setInterval(() => {
    const c = repliesConfig();
    if (!c.enabled || checking) return;
    const st = getSettings().replies_inbox_status || {};
    // après un échec (mot de passe refusé, serveur injoignable), on n'insiste pas : nouvel essai au plus toutes les 15 minutes
    const wait = Math.max(c.interval || 5, st.error ? 15 : 0) * 60000;
    if (st.at && !st.pending && Date.now() - new Date(st.at).getTime() < wait) return;
    checkReplies().catch((e) => console.error('Réponses par e-mail :', e.message));
  }, 60_000);
}
