// Conversation par e-mail gardée dans la fiche : chaque e-mail envoyé depuis une facture ou un OR porte un identifiant ;
// la réponse du client, relevée dans la boîte du garage, est rangée dans la même fiche (texte, expéditeur, pièces jointes).
// Les modules sont appelés directement sur une base vide ; l'envoi est simulé (aucun e-mail ne part).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-replies-'));
let db, Bz, M, R, admin, customer, invoice, order;

before(async () => {
  Object.assign(process.env, { DATA_DIR: dataDir, MAIL_TRANSPORT: 'json', ANTHROPIC_API_KEY: '', TZ: 'Europe/Luxembourg' });
  db = await import('../src/db.js');
  Bz = await import('../src/business.js');
  M = await import('../src/mail.js');
  R = await import('../src/replies.js');
  admin = db.insert('users', { name: 'Gérant', email: 'gerant@garage-test.lu', role: 'admin', active: 1 }, ['name', 'email', 'role', 'active']);
  M.saveMailConfig({ host: 'smtp.garage-test.lu', port: 587, user: 'atelier@garage-test.lu', pass: 'secret-smtp', from_name: 'Garage Test', from_email: 'atelier@garage-test.lu' });
  customer = db.insert('customers', { name: 'Marc Weber', email: 'marc.weber@example.com' }, ['name', 'email']);
  const lines = [{ kind: 'labor', description: 'Vidange', quantity: 1, unit_price: 80, tax_rate: 17 }];
  invoice = Bz.saveDocument({ type: 'invoice', customer_id: customer, lines });
  Bz.postInvoice(invoice);
  order = Bz.saveDocument({ type: 'order', customer_id: customer, lines });
});
after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

const raw = (m) => new MailComposer(m).compile().build();
const sent = (model, id) => db.all("SELECT * FROM emails WHERE model=? AND record_id=? AND status='sent' ORDER BY id", model, id);
const thread = (model, id) => M.chatter(model, id).messages.slice().reverse();
const send = (id, extra = {}) => M.sendEmail({ model: 'document', record_id: id, to: 'marc.weber@example.com', subject: 'Votre facture', intro: 'Bonjour,\n\nVoici votre facture.', include_document: false, user_id: admin, ...extra });

test('chaque e-mail envoyé porte un identifiant, et le suivant s’inscrit dans la même conversation', async () => {
  await send(invoice, { subject: 'Facture — Garage Test' });
  const [first] = sent('document', invoice);
  assert.match(first.message_id, /^<garage\.\d+\.[0-9a-f]{16}@garage-test\.lu>$/);
  await send(invoice, { subject: 'Facture — Garage Test', intro: 'Bonjour,\n\nPetit rappel.' });
  const all = sent('document', invoice);
  assert.equal(all.length, 2);
  assert.notEqual(all[0].message_id, all[1].message_id);
  assert.deepEqual(M.threadIds('document', invoice), all.map((e) => e.message_id));
  // la fiche montre le texte de chaque e-mail envoyé, pas seulement « e-mail envoyé »
  const t = thread('document', invoice).filter((m) => m.kind === 'email');
  assert.equal(t.length, 2);
  assert.match(t[1].email_intro, /Petit rappel/);
  assert.equal(t[1].email_to, 'marc.weber@example.com');
});

test('la réponse du client revient dans la fiche : expéditeur, texte sans la copie de notre message, pièce jointe, rappel', async () => {
  const first = sent('document', invoice)[0];
  const pdf = Buffer.from('%PDF-1.4\n% preuve de virement\n');
  const reply = await raw({
    from: '"Marc Weber" <marc.weber@example.com>', to: 'atelier@garage-test.lu', subject: 'Re: Facture — Garage Test', messageId: '<reponse-1@example.com>',
    inReplyTo: first.message_id, references: first.message_id,
    text: 'Bonjour,\n\nJ’ai fait le virement ce matin, voici la preuve.\n\nCordialement,\nMarc\n\nLe lun. 16 nov. 2026 à 09:12, Garage Test <atelier@garage-test.lu> a écrit :\n> Bonjour,\n>\n> Voici votre facture.\n',
    attachments: [{ filename: 'virement.pdf', content: pdf, contentType: 'application/pdf' }, { filename: 'macro.exe', content: Buffer.from('MZ'), contentType: 'application/x-msdownload' }],
  });
  const r = await R.processReply(reply);
  assert.equal(r.matched, true);
  assert.equal(r.model, 'document');
  assert.equal(r.record_id, invoice);
  assert.equal(r.files, 1, 'le PDF est gardé, le programme non');
  const m = thread('document', invoice).at(-2); // (le dernier message est le rappel créé pour le gérant)
  const got = thread('document', invoice).find((x) => x.kind === 'email_in');
  assert.ok(got, JSON.stringify(m));
  assert.equal(got.from_addr, 'Marc Weber <marc.weber@example.com>');
  assert.equal(got.subject, 'Re: Facture — Garage Test');
  assert.match(got.body, /J’ai fait le virement ce matin/);
  assert.ok(!/Voici votre facture|a écrit/.test(got.body), 'la copie de notre message est retirée : ' + got.body);
  const files = db.all("SELECT filename, mime, source FROM attachments WHERE model='document' AND record_id=?", invoice);
  assert.deepEqual(files.map((f) => f.filename), ['virement.pdf']);
  assert.equal(files[0].source, `email:${got.id}`);
  // un rappel pour la personne qui avait écrit au client
  const acts = db.all("SELECT summary, user_id, type FROM activities WHERE model='document' AND record_id=? AND status='planned'", invoice);
  assert.equal(acts.length, 1);
  assert.match(acts[0].summary, /^Réponse de Marc Weber/);
  assert.equal(acts[0].user_id, admin);
  // le même e-mail relevé une deuxième fois n'est pas rangé deux fois
  assert.equal((await R.processReply(reply)).skipped, true);
  assert.equal(thread('document', invoice).filter((x) => x.kind === 'email_in').length, 1);
  // une deuxième réponse n'ajoute pas un deuxième rappel tant que le premier n'est pas traité
  const again = await raw({ from: 'marc.weber@example.com', to: 'atelier@garage-test.lu', subject: 'Re: Facture — Garage Test', messageId: '<reponse-2@example.com>', inReplyTo: first.message_id, text: 'Encore merci.' });
  assert.equal((await R.processReply(again)).matched, true);
  assert.equal(db.all("SELECT 1 FROM activities WHERE model='document' AND record_id=? AND status='planned'", invoice).length, 1);
});

test('notre réponse suivante cite la réponse du client : la conversation reste groupée', async () => {
  const contact = M.conversationContact('document', invoice);
  assert.equal(contact.to, 'marc.weber@example.com');
  assert.equal(contact.subject, 'Re: Facture — Garage Test');
  assert.equal(contact.replying, true);
  assert.deepEqual(M.threadIds('document', invoice).slice(-2), ['<reponse-1@example.com>', '<reponse-2@example.com>']);
  await send(invoice, { subject: contact.subject, intro: 'Bien reçu, merci.' });
  assert.equal(M.threadIds('document', invoice).length, 5);
});

test('réponse qui cite un message plus ancien (References), ou seulement le numéro du document dans l’objet', async () => {
  await send(order, { subject: 'Prise en charge de votre véhicule' });
  const mid = sent('document', order)[0].message_id;
  const viaRefs = await raw({ from: 'marc.weber@example.com', to: 'atelier@garage-test.lu', subject: 'Re: Prise en charge', messageId: '<ref-1@example.com>', references: ['<autre@example.com>', mid], text: 'D’accord pour jeudi.' });
  const a = await R.processReply(viaRefs);
  assert.equal(a.matched, true);
  assert.equal(a.record_id, order);
  // sans aucune référence : le numéro de la facture dans l'objet, écrit par le client à qui elle a été envoyée
  const number = db.get('SELECT number FROM documents WHERE id=?', invoice).number;
  const viaSubject = await raw({ from: 'marc.weber@example.com', to: 'atelier@garage-test.lu', subject: `Question sur la facture ${number}`, messageId: '<sujet-1@example.com>', text: 'Pouvez-vous me rappeler ?' });
  const b = await R.processReply(viaSubject);
  assert.equal(b.matched, true);
  assert.equal(b.record_id, invoice);
  // le même numéro écrit par un inconnu : l'e-mail n'entre pas dans la fiche
  const stranger = await raw({ from: 'inconnu@example.org', to: 'atelier@garage-test.lu', subject: `Facture ${number}`, messageId: '<sujet-2@example.com>', text: 'Bonjour' });
  assert.equal((await R.processReply(stranger)).matched, false);
});

test('les e-mails sans rapport avec le logiciel ne sont ni rangés ni gardés', async () => {
  const before = db.get('SELECT COUNT(*) AS n FROM messages').n;
  const other = await raw({ from: 'newsletter@example.org', to: 'atelier@garage-test.lu', subject: 'Promotions de novembre', messageId: '<pub-1@example.org>', text: 'Bonjour' });
  const r = await R.processReply(other);
  assert.equal(r.matched, false);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM messages').n, before);
  assert.equal(db.get("SELECT matched FROM mail_seen WHERE message_id='<pub-1@example.org>'").matched, 0);
  // une copie de notre propre envoi arrivée dans la boîte n'est pas une réponse
  const mid = sent('document', invoice)[0].message_id;
  const own = await raw({ from: 'atelier@garage-test.lu', to: 'marc.weber@example.com', subject: 'Facture — Garage Test', messageId: '<copie-1@garage-test.lu>', inReplyTo: mid, text: 'copie' });
  assert.equal((await R.processReply(own)).matched, false);
});

test('texte d’une réponse : la partie citée est retirée (plusieurs messageries), un message HTML est lu', async () => {
  assert.equal(R.cleanReply('Oui, c’est bon.\n\n-----Original Message-----\nFrom: Garage\nSent: lundi\n\nBonjour'), 'Oui, c’est bon.');
  assert.equal(R.cleanReply('Parfait.\n\nDe : Garage Test <a@b.lu>\nEnvoyé : lundi 16 novembre 2026 09:12\nÀ : Marc\nObjet : Facture\n\nBonjour'), 'Parfait.');
  assert.equal(R.cleanReply('Merci\n\nAm Mo., 16. Nov. 2026 um 09:12 Uhr schrieb Garage Test <a@b.lu>:\n> Bonjour'), 'Merci');
  assert.equal(R.cleanReply('OK pour moi\n\n> Bonjour,\n> Voici votre devis.\n'), 'OK pour moi');
  // (un message qui ne contient que la citation est gardé tel quel plutôt que vide)
  assert.equal(R.cleanReply('> seulement la citation'), '> seulement la citation');
  const mid = sent('document', order)[0].message_id;
  const html = await raw({ from: 'marc.weber@example.com', to: 'atelier@garage-test.lu', subject: 'Re: Prise en charge', messageId: '<html-1@example.com>', inReplyTo: mid,
    html: '<div>Bonjour,<br>Je passe <b>demain</b>.</div><script>alert(1)</script>' });
  const r = await R.processReply(html);
  assert.equal(r.matched, true);
  const got = db.get('SELECT body FROM messages WHERE id=?', r.message);
  assert.match(got.body, /Je passe \*?demain\*?/);
  assert.ok(!/<|script|alert/.test(got.body), got.body);
});

test('réglages de la boîte de réception : le mot de passe ne ressort jamais', () => {
  R.saveRepliesConfig({ enabled: true, host: 'imap.garage-test.lu', same_login: false, user: 'atelier@garage-test.lu', pass: 'secret-imap', interval: 0.2 });
  const pub = R.publicRepliesConfig();
  assert.equal(pub.has_pass, true);
  assert.equal(pub.pass, undefined);
  assert.ok(!JSON.stringify(pub).includes('secret-imap'));
  assert.equal(pub.interval, 1, 'relève au plus une fois par minute');
  assert.equal(pub.port, 993);
  // un enregistrement sans mot de passe garde celui qui existe
  R.saveRepliesConfig({ enabled: false });
  assert.equal(db.getSettings().replies_inbox.pass, 'secret-imap');
  assert.equal(R.publicRepliesConfig().enabled, false);
});

// ---------- Relève de la boîte : faux serveur de messagerie local (rien ne sort de la machine) ----------
// Juste assez du protocole IMAP pour que le logiciel se connecte, cherche les messages récents et les lise.
import net from 'node:net';
function fakeImap(messages, opts = {}) {
  const log = [];
  const server = net.createServer((sock) => {
    let buf = '';
    const send = (s) => sock.write(s + '\r\n');
    send('* OK [CAPABILITY IMAP4rev1] faux serveur de test');
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, ...rest] = line.split(' ');
        const cmd = rest.join(' ');
        const up = cmd.toUpperCase();
        if (!up.startsWith('LOGIN')) log.push(cmd);
        if (up.startsWith('CAPABILITY')) { send('* CAPABILITY IMAP4rev1'); send(`${tag} OK`); }
        else if (up.startsWith('LOGIN')) { log.push('LOGIN'); send(`${tag} OK [CAPABILITY IMAP4rev1] connecté`); }
        else if (up.startsWith('EXAMINE') || up.startsWith('SELECT')) {
          send(`* ${messages.length} EXISTS`); send('* 0 RECENT'); send('* FLAGS (\\Seen \\Answered)'); send('* OK [UIDVALIDITY 7] ok'); send(`* OK [UIDNEXT ${messages.length + 1}] ok`);
          send(`${tag} OK [${up.startsWith('EXAMINE') ? 'READ-ONLY' : 'READ-WRITE'}] ouvert`);
        } else if (up.startsWith('UID SEARCH')) { if (opts.dropOn === 'search') { sock.destroy(); return; } send(`* SEARCH ${messages.map((m, n) => n + 1).join(' ')}`); send(`${tag} OK`); }
        else if (up.startsWith('UID FETCH')) {
          const set = up.split(' ')[2];
          const wanted = new Set(set.split(',').flatMap((p) => { const [a, b] = p.split(':').map(Number); return Array.from({ length: (b || a) - a + 1 }, (_, k) => a + k); }));
          messages.forEach((m, n) => {
            const uid = n + 1;
            if (!wanted.has(uid)) return;
            if (/BODY(\.PEEK)?\[\]/.test(up) && opts.dropOn === 'body') { sock.destroy(); return; }
            if (/BODY(\.PEEK)?\[\]/.test(up)) { sock.write(`* ${uid} FETCH (UID ${uid} BODY[] {${m.raw.length}}\r\n`); sock.write(m.raw); sock.write(')\r\n'); }
            else send(`* ${uid} FETCH (UID ${uid} RFC822.SIZE ${m.raw.length} ENVELOPE ("Mon, 16 Nov 2026 09:30:00 +0100" "sujet" NIL NIL NIL NIL NIL NIL NIL "${m.id}"))`);
          });
          send(`${tag} OK`);
        } else if (up.startsWith('LOGOUT')) { send('* BYE'); send(`${tag} OK`); sock.end(); }
        else send(`${tag} OK`);
      }
    });
    sock.on('error', () => {});
  });
  return { server, log, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}

test('relève de la boîte du garage : lecture seule, seules les réponses sont rangées, rien n’est relu deux fois', async () => {
  const mid = sent('document', order)[0].message_id;
  const messages = [
    { id: '<imap-reponse@example.com>', raw: await raw({ from: 'marc.weber@example.com', to: 'atelier@garage-test.lu', subject: 'Re: Prise en charge', messageId: '<imap-reponse@example.com>', inReplyTo: mid, text: 'Message relevé dans la boîte.' }) },
    { id: '<imap-autre@example.org>', raw: await raw({ from: 'fournisseur@example.org', to: 'atelier@garage-test.lu', subject: 'Nos tarifs', messageId: '<imap-autre@example.org>', text: 'Sans rapport.' }) },
  ];
  const imap = fakeImap(messages);
  const port = await imap.listen();
  try {
    R.saveRepliesConfig({ enabled: false, host: '127.0.0.1', port, secure: false, same_login: false, user: 'atelier@garage-test.lu', pass: 'secret-imap' });
    const before = thread('document', order).filter((m) => m.kind === 'email_in').length;
    const r = await R.checkReplies();
    assert.equal(r.error, null);
    assert.equal(r.read, 2);
    assert.equal(r.matched, 1);
    const got = thread('document', order).filter((m) => m.kind === 'email_in');
    assert.equal(got.length, before + 1);
    assert.equal(got.at(-1).body, 'Message relevé dans la boîte.');
    // la boîte n'est pas modifiée : ouverte en lecture seule, aucun message marqué, déplacé, copié ou supprimé
    const cmds = imap.log.map((c) => c.toUpperCase());
    assert.ok(cmds.some((c) => c.startsWith('EXAMINE')), cmds.join(' | '));
    assert.ok(!cmds.some((c) => /^(SELECT|UID STORE|STORE|UID MOVE|UID COPY|UID EXPUNGE|EXPUNGE|APPEND|DELETE|CREATE)/.test(c)), cmds.join(' | '));
    assert.equal(db.getSettings().replies_inbox_status.matched, 1);
    // deuxième relève : les deux messages sont connus, leur contenu n'est même plus téléchargé
    imap.log.length = 0;
    const again = await R.checkReplies();
    assert.equal(again.read, 0);
    assert.equal(again.matched, 0);
    assert.ok(!imap.log.some((c) => /BODY/i.test(c)), imap.log.join(' | '));
    assert.equal(thread('document', order).filter((m) => m.kind === 'email_in').length, before + 1);
  } finally { imap.server.close(); }
});

// ---------- Suites de la relecture ----------
const useImap = async (messages, opts, fn) => {
  const imap = fakeImap(messages, opts);
  const port = await imap.listen();
  R.saveRepliesConfig({ enabled: false, host: '127.0.0.1', port, secure: false, same_login: false, user: 'atelier@garage-test.lu', pass: 'secret-imap' });
  try { return await fn(imap); } finally { imap.server.close(); }
};
const other = async (n) => ({ id: `<lot-${n}@example.org>`, raw: await raw({ from: 'pub@example.org', to: 'atelier@garage-test.lu', subject: 'Promotion ' + n, messageId: `<lot-${n}@example.org>`, text: 'Sans rapport.' }) });

test('une coupure de connexion pendant la relève ne fait pas tomber le logiciel', async () => {
  const crashes = [];
  const onCrash = (e) => crashes.push(e);
  process.on('uncaughtException', onCrash);
  try {
    const mid = sent('document', order)[0].message_id;
    const msg = { id: '<coupure-1@example.com>', raw: await raw({ from: 'marc.weber@example.com', to: 'atelier@garage-test.lu', subject: 'Re: Prise en charge', messageId: '<coupure-1@example.com>', inReplyTo: mid, text: 'Après la coupure.' }) };
    for (const dropOn of ['search', 'body']) {
      await useImap([msg], { dropOn }, async () => {
        await assert.rejects(() => R.checkReplies(), /Connexion à la boîte de réception impossible/);
        assert.match(db.getSettings().replies_inbox_status.error, /Connexion à la boîte de réception impossible/);
      });
    }
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(crashes.map((e) => e.message), [], 'aucune erreur ne doit remonter jusqu’au logiciel');
    // la relève suivante fonctionne (rien n'est resté « en cours ») et la réponse est bien rangée
    await useImap([msg], {}, async () => { const r = await R.checkReplies(); assert.equal(r.matched, 1); });
  } finally { process.off('uncaughtException', onCrash); }
});

test('un e-mail piégé (objet ou HTML démesuré) ne bloque pas le logiciel', async () => {
  const t0 = Date.now();
  const a = await raw({ from: 'x@example.org', to: 'atelier@garage-test.lu', subject: '7'.repeat(60000), messageId: '<piege-1@example.org>', text: 'x' });
  assert.equal((await R.processReply(a)).matched, false);
  const mid = sent('document', order)[0].message_id;
  const b = await raw({ from: 'marc.weber@example.com', to: 'atelier@garage-test.lu', subject: 'Re: Prise en charge', messageId: '<piege-2@example.com>', inReplyTo: mid, html: '<a<'.repeat(130000) });
  assert.equal((await R.processReply(b)).matched, true);
  assert.ok(R.stripHtml('<style'.repeat(40000) + '<p>ok</p>').length < 10);
  assert.equal(R.stripHtml('<div>Bonjour &amp; merci<br>À demain</div><style>p{color:red}</style><SCRIPT>alert(1)</SCRIPT>').trim(), 'Bonjour & merci\nÀ demain');
  assert.ok(Date.now() - t0 < 3000, `trop lent : ${Date.now() - t0} ms`);
});

test('réponses écrites dans le message cité : rien n’est perdu, et le message complet reste consultable', async () => {
  // réponses entre les lignes citées : tout est gardé
  const inline = 'Bonjour, mes réponses ci-dessous :\n\nLe lun. 16 nov. 2026 à 09:12, Garage Test <atelier@garage-test.lu> a écrit :\n> Pouvez-vous déposer la voiture jeudi matin ?\nOui, jeudi à 8h.\n> Faut-il aussi changer les plaquettes arrière (180 €) ?\nOui, d’accord pour les plaquettes.';
  assert.match(R.cleanReply(inline), /Oui, jeudi à 8h\./);
  assert.match(R.cleanReply(inline), /d’accord pour les plaquettes/);
  // réponse écrite SOUS le message cité
  assert.match(R.cleanReply('Le lun. 16 nov. 2026 à 09:12, Garage <a@b.lu> a écrit :\n> Votre voiture est prête.\n\nMerci, je passe demain.'), /je passe demain/);
  // une phrase du client qui ressemble à un en-tête de citation n'est pas coupée
  const phrase = 'Bonjour,\nLe mécanicien m’a écrit que la voiture serait prête vendredi, mais il reste deux questions :\n1) le prix final ?\n2) puis-je payer par virement ?';
  assert.equal(R.cleanReply(phrase), phrase);
  // style Outlook (ancien message recopié sans « > ») : la fiche montre le début, le message complet est gardé à part
  const mid = sent('document', order)[0].message_id;
  const outlook = await raw({ from: 'marc.weber@example.com', to: 'atelier@garage-test.lu', subject: 'RE: Prise en charge', messageId: '<outlook-1@example.com>', inReplyTo: mid,
    text: 'Bonjour,\nVoir mes réponses en majuscules ci-dessous.\n\nDe : Garage Test <atelier@garage-test.lu>\nEnvoyé : lundi 16 novembre 2026 09:12\nÀ : Marc Weber\nObjet : Prise en charge\n\nAcceptez-vous le devis ? OUI\nSouhaitez-vous un véhicule de prêt ? NON, PAS CETTE FOIS' });
  const r = await R.processReply(outlook);
  const m = db.get('SELECT body, body_full FROM messages WHERE id=?', r.message);
  assert.equal(m.body, 'Bonjour,\nVoir mes réponses en majuscules ci-dessous.');
  assert.match(m.body_full, /Acceptez-vous le devis \? OUI/);
  assert.match(m.body_full, /NON, PAS CETTE FOIS/);
  // un message sans partie citée n'a pas de « message complet » en double
  const plain = await raw({ from: 'marc.weber@example.com', to: 'atelier@garage-test.lu', subject: 'Re: Prise en charge', messageId: '<simple-1@example.com>', inReplyTo: mid, text: 'Parfait, merci.' });
  assert.equal(db.get('SELECT body_full FROM messages WHERE id=?', (await R.processReply(plain)).message).body_full, null);
  assert.equal(thread('document', order).find((x) => x.id === r.message).body_full, m.body_full, 'la fiche reçoit le message complet');
});

test('photo glissée dans le message gardée, logo de signature ignoré ; l’adresse de réponse est la vraie', async () => {
  const mid = sent('document', order)[0].message_id;
  const photo = Buffer.alloc(400 * 1024, 7), logo = Buffer.alloc(3000, 1);
  const mail = await raw({ from: '"ailleurs@autre-domaine.org" <marc.weber@example.com>', to: 'atelier@garage-test.lu', subject: 'Re: Prise en charge', messageId: '<photo-1@example.com>', inReplyTo: mid,
    html: '<p>Voici la photo de la rayure</p><img src="cid:photo1"><img src="cid:logo1">',
    attachments: [{ filename: 'rayure.jpg', content: photo, contentType: 'image/jpeg', cid: 'photo1' }, { filename: 'logo.png', content: logo, contentType: 'image/png', cid: 'logo1' }] });
  const r = await R.processReply(mail);
  assert.equal(r.matched, true);
  assert.deepEqual(db.all('SELECT filename FROM attachments WHERE source=?', `email:${r.message}`).map((f) => f.filename), ['rayure.jpg']);
  // un nom affiché qui contient une autre adresse est ignoré : on répond à l'adresse réelle
  assert.equal(db.get('SELECT from_addr FROM messages WHERE id=?', r.message).from_addr, 'marc.weber@example.com');
  assert.equal(M.conversationContact('document', order).to, 'marc.weber@example.com');
  db.run("UPDATE messages SET from_addr='ancien@autre.org <marc.weber@example.com>' WHERE id=?", r.message);
  assert.equal(M.conversationContact('document', order).to, 'marc.weber@example.com');
});

test('le même e-mail traité deux fois en même temps n’est rangé qu’une fois', async () => {
  const mid = sent('document', order)[0].message_id;
  const mail = await raw({ from: 'marc.weber@example.com', to: 'atelier@garage-test.lu', subject: 'Re: Prise en charge', messageId: '<double-1@example.com>', inReplyTo: mid, text: 'Une seule fois.' });
  const res = await Promise.all([R.processReply(mail), R.processReply(mail)]);
  assert.equal(res.filter((x) => x.matched).length, 1);
  assert.equal(db.all("SELECT 1 FROM messages WHERE message_id='<double-1@example.com>'").length, 1);
});

test('un simple message écrit depuis un devis en brouillon ne le marque pas « Envoyé »', async () => {
  const quote = Bz.saveDocument({ type: 'quote', customer_id: customer, lines: [{ kind: 'labor', description: 'Diagnostic', quantity: 1, unit_price: 60, tax_rate: 17 }] });
  await send(quote, { subject: 'Question', intro: 'Quelle est votre plaque ?', include_document: false });
  assert.equal(db.get('SELECT status FROM documents WHERE id=?', quote).status, 'draft');
  await send(quote, { subject: 'Votre devis', intro: 'Voici le devis.', include_document: true });
  assert.equal(db.get('SELECT status FROM documents WHERE id=?', quote).status, 'sent');
});

test('après une longue interruption, la relève remonte jusqu’à la dernière relève réussie ; un gros arriéré est relevé par lots', async () => {
  const sinceOf = (imap) => imap.log.map((c) => /SINCE (\S+)/i.exec(c)?.[1]).find(Boolean);
  const days = (d) => Math.round((Date.now() - new Date(d).getTime()) / 86400000);
  // dernière relève réussie il y a 20 jours (garage fermé, mot de passe changé…), puis des échecs : on cherche 21 jours en arrière
  const ago = (n) => db.localDateTime(new Date(Date.now() - n * 86400000));
  db.setSetting('replies_inbox_status', { at: ago(1), ok_at: ago(20), error: 'mot de passe refusé' });
  await useImap([], {}, async (imap) => { await R.checkReplies(); assert.ok([20, 21, 22].includes(days(sinceOf(imap))), sinceOf(imap)); });
  // relève réussie à l'instant : 4 jours suffisent
  await useImap([], {}, async (imap) => { await R.checkReplies(); assert.ok([4, 5].includes(days(sinceOf(imap))), sinceOf(imap)); });
  // jamais réussie (premier essai raté) : toujours 14 jours
  db.setSetting('replies_inbox_status', { at: ago(0), ok_at: null, error: 'mot de passe refusé' });
  await useImap([], {}, async (imap) => { await R.checkReplies(); assert.ok([14, 15].includes(days(sinceOf(imap))), sinceOf(imap)); });
  // pas plus de 60 jours
  db.setSetting('replies_inbox_status', { at: ago(0), ok_at: ago(400) });
  await useImap([], {}, async (imap) => { await R.checkReplies(); assert.ok([60, 61].includes(days(sinceOf(imap))), sinceOf(imap)); });
  // arriéré : 160 e-mails inconnus → 150 lus, 10 en attente ; la période ne raccourcit pas tant qu'il en reste
  const many = [];
  for (let n = 0; n < 160; n++) many.push(await other(n));
  const nine = ago(9);
  db.setSetting('replies_inbox_status', { at: ago(1), ok_at: nine });
  await useImap(many, {}, async () => {
    const r1 = await R.checkReplies();
    assert.equal(r1.read, 150);
    assert.equal(r1.pending, 10);
    assert.equal(db.getSettings().replies_inbox_status.ok_at, nine, 'la relève n’est « réussie » qu’une fois l’arriéré vidé');
    const r2 = await R.checkReplies();
    assert.equal(r2.read, 10);
    assert.equal(r2.pending, 0);
    assert.equal(db.getSettings().replies_inbox_status.ok_at, r2.at);
  });
});

test('même boîte que la réception des factures fournisseurs : le réglage le signale', () => {
  R.saveRepliesConfig({ host: 'imap.garage-test.lu', port: 993, secure: true, same_login: false, user: 'Atelier@garage-test.lu', folder: 'INBOX' });
  assert.equal(R.publicRepliesConfig().shared_with, null);
  db.setSetting('bills_inbox', { host: 'IMAP.garage-test.lu', user: 'atelier@garage-test.lu', pass: 'x', folder: 'INBOX' });
  assert.equal(R.publicRepliesConfig().shared_with, 'bills');
  db.setSetting('bills_inbox', { host: 'imap.garage-test.lu', user: 'factures@garage-test.lu', pass: 'x' });
  assert.equal(R.publicRepliesConfig().shared_with, null);
  // « même identifiant que pour l'envoi » : c'est l'identifiant d'envoi qui compte
  R.saveRepliesConfig({ same_login: true });
  db.setSetting('bills_inbox', { host: 'imap.garage-test.lu', user: 'atelier@garage-test.lu', pass: 'x' });
  assert.equal(R.publicRepliesConfig().shared_with, 'bills');
});
