process.env.TZ ||= 'Europe/Luxembourg';

import express from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { db, dataDir, all, get, run, insert, update, tx, today, getSettings, setSetting, round2, localDateTime, isDate, likeFold } from './src/db.js';
import { hashSecret, verifySecret, createSession, currentUser, requireAuth, purgeSessions } from './src/auth.js';
import {
  BusinessError, createMove, getDocument, saveDocument, convertDocument, postInvoice, registerPayment, addStockMove,
  getPurchase, savePurchase, receivePurchase, postPurchase, dashboard, trialBalance, vatReport, profitAndLoss, durationHours,
  touchDocument,
} from './src/business.js';
import { parseCamt, parseCsv, importLines, suggestions, matchLine, assignLine, autoReconcile, syncAccount, cancelPayment, unmatchLine, remainingOf, PROVIDERS } from './src/bank.js';
import { AGENTS } from './src/agents.js';
import {
  MODELS, MODULES, ACTIVITY_TYPES, TEMPLATE_LABELS, publicMailConfig, saveMailConfig, testMail, compose, renderEmail, sendEmail, processScheduledEmails,
  logMessage, chatter, listActivities, createActivity, completeActivity, activityCounts, ACTIVITY_COLS, recordInfo, isMailConfigured, recoverInterruptedEmails,
} from './src/mail.js';
import { runAgent, friendlyError } from './src/claude.js';
import {
  copilotConfig, saveCopilotConfig, addJournal, journalOf, copilotChat, generateBrief, listBriefs, dayStats, startCopilotScheduler,
} from './src/copilot.js';
import {
  createBillFromFile, reanalyze, listAttachments, attachmentFile, deleteAttachment, saveAttachment, publicInboxConfig, saveInboxConfig, testInbox, checkInbox, startInboxPolling,
} from './src/bills.js';
import { mountLive, stageFromStatus, ensureLink, publicUrl, publish as livePublish } from './src/live.js';
import { kioskLines, isIntervention, stopLineTimers, stopOrderTimers, workStats } from './src/worktime.js';
import { publicOdooConfig, saveOdooConfig, testConnection, runImport, job as odooJob } from './src/odoo.js';
import { chat, meeting, clearHistory, aiConfigured } from './src/claude.js';
import { saveLogo, deleteLogo, logoFile, cleanLayout, saveBackground, deleteBackground } from './src/branding.js';
import { APPS, LEVELS, LEVEL_LABELS, PRESETS, accessGuard, effectivePerms, can, normalizePerms, recordApp, queryList, maskDashboard, createInvite, findInvite, clearInvite } from './src/access.js';
import { attendanceConfig, ATTENDANCE_DEFAULTS, statusOf, checkInOut, board, listAttendance, attendanceReport, saveAttendance, validDateTime, period as datePeriod } from './src/attendance.js';
import { options, cleanOptions, startAutomation, runFollowups, runAppointmentReminders } from './src/automation.js';
import { stages, listLeads, getLead, saveLead, moveLead, markWon, markLost, restoreLead, ensureCustomer, createQuote, pipelineStats, saveStage, deleteStage, SOURCES, LOST_REASONS } from './src/crm.js';
import { websiteConfig, saveWebsite, renderSite, generateWebsite, saveSiteImage, siteMediaFile, submitContact, BLOCK_TYPES } from './src/website.js';
import { PLATFORMS, publicAccounts, saveAccounts, listPosts, getPost, savePost, publishPost, markManualDone, writePosts, postIdeas } from './src/social.js';
import { listConversations, conversationMessages, getConversation, updateConversation, deleteConversation, ownsConversation } from './src/conversations.js';
import { startScheduler, computeNextRun, executeTask, running } from './src/scheduler.js';

const app = express();
// Adresses sensibles à la casse : /api/Customers n'existe pas (sinon les droits d'accès, comparés en minuscules, seraient contournables)
app.set('case sensitive routing', true);
// Confiance uniquement dans un proxy local (Caddy dans Docker, Tailscale serve…) : l'adresse IP réelle et le https viennent de lui
// Sur le PC du garage, seul un proxy local est cru (Tailscale serve, tunnel Cloudflare : ils parlent depuis 127.0.0.1) ;
// un appareil du Wi-Fi ne peut donc pas se faire passer pour une autre adresse avec un en-tête X-Forwarded-For.
// Sur un serveur internet (Docker + Caddy, Render…), le proxy de l'hébergeur est sur un réseau privé : il est cru aussi.
app.set('trust proxy', process.env.TRUST_PROXY || (process.env.INTERNET_SERVER === '1' ? 'loopback, linklocal, uniquelocal' : 'loopback'));
// Formulaires publics (connexion, kiosque) : petits messages seulement ; le reste accepte les photos et pièces jointes
app.use(['/api/auth', '/api/kiosk/login', '/api/kiosk/badge', '/site-api'], express.json({ limit: '20kb' }));
app.use(/^\/live-api\/[^/]+\/(posts|stage|lines)/, express.json({ limit: '50kb' }));
// Dépôts de fichiers (pièces jointes, factures fournisseurs, images) : le fichier est lu tel quel, octet pour octet —
// sans passer par les lecteurs JSON / texte ci-dessous, qui altéraient les fichiers .txt, .csv, .xml et refusaient les .json
const UPLOAD_ROUTES = /^\/(api\/(bills\/upload|attachments\/|website\/images|social\/images|settings\/(logo|home-bg)|live\/\d+\/upload)|live-api\/[^/]+\/upload)/;
const jsonBody = express.json({ limit: '20mb' });
const textBody = express.text({ type: ['text/*', 'application/xml'], limit: '20mb' });
app.use((req, res, next) => (UPLOAD_ROUTES.test(req.path) ? next() : jsonBody(req, res, (e) => (e ? next(e) : textBody(req, res, next)))));

// Fichiers statiques + librairies locales (fonctionne sans internet)
const nm = (p) => path.resolve('node_modules', p);
app.use('/vendor/vue.js', express.static(nm('vue/dist/vue.esm-browser.prod.js')));
app.use('/vendor/marked.js', express.static(nm('marked/lib/marked.esm.js')));
app.use('/vendor/purify.js', express.static(nm('dompurify/dist/purify.es.mjs')));
app.use('/vendor/three', express.static(nm('three')));
app.use('/vendor/fonts/inter.woff2', express.static(nm('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')));
app.use('/vendor/fonts/space-grotesk.woff2', express.static(nm('@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2')));
app.use('/vendor/fonts/instrument-serif.woff2', express.static(nm('@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2')));
// Jeu d'icônes (Lucide) limité aux icônes utilisées, servi comme module JS
const ICONS = ['LayoutDashboard', 'Bot', 'AlarmClock', 'Mail', 'Wrench', 'CalendarDays', 'Timer', 'FileText', 'Receipt', 'Users', 'Car', 'Package', 'ShoppingCart', 'Factory', 'Landmark', 'BookOpen', 'Settings', 'Search', 'Plus', 'Menu', 'Home', 'Moon', 'Sun', 'Smartphone', 'MonitorSmartphone', 'Download', 'LogOut', 'Sparkles', 'Mic', 'MicOff', 'Send', 'X', 'Volume2', 'Square', 'NotebookPen', 'CalendarCheck', 'Zap', 'TrendingUp', 'Wallet', 'Gauge', 'Bell', 'Tablet', 'History', 'Scan', 'List', 'VolumeX', 'MessageCircle', 'PhoneOff', 'AudioLines', 'Pin', 'Brain', 'ListTodo', 'UserCheck', 'Contact', 'ShieldCheck', 'UserPlus', 'Link', 'Copy', 'Clock', 'LogIn', 'ScanLine', 'ChartColumn', 'LayoutGrid', 'KeyRound', 'ChevronRight', 'ArrowLeft', 'CircleUser', 'PanelLeft', 'Briefcase', 'Pencil', 'Trash2', 'Check', 'Image', 'Upload', 'Coffee', 'Sunrise', 'Moon', 'Delete', 'Handshake', 'Globe', 'Megaphone', 'Eye', 'EyeOff', 'ArrowUp', 'ArrowDown', 'ExternalLink', 'Star', 'Trophy', 'ThumbsDown', 'Lightbulb', 'Phone', 'CalendarClock', 'WandSparkles', 'Rocket', 'Undo2', 'Kanban'];
let iconModule = null;
app.get('/vendor/icons.js', async (req, res) => {
  if (!iconModule) {
    const lucide = await import('lucide');
    const map = Object.fromEntries(ICONS.filter((n) => lucide[n]).map((n) => [n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([a-z])([0-9])/g, '$1-$2').toLowerCase(), lucide[n]]));
    iconModule = `export default ${JSON.stringify(map)};`;
  }
  res.type('application/javascript').set('Cache-Control', 'public, max-age=86400').send(iconModule);
});
// ---------- Installation sur téléphone ----------
function lanUrls(port) {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.') && !i.address.startsWith('172.17.'))
    .map((i) => `http://${i.address}:${port}/`);
}
// Adresse sécurisée connue : adresse publique saisie (ou PUBLIC_URL), sinon l'adresse https utilisée en ce moment
function secureUrl(req) {
  const pub = getSettings().public_url;
  if (pub && /^https:\/\//.test(pub)) return pub.replace(/\/?$/, '/');
  return req.secure ? `https://${req.get('host')}/` : null;
}
// Service worker : liste des fichiers de l'interface gardés sur le téléphone (ouverture même sans réseau).
// Calculée au démarrage ; la version change dès qu'un fichier change, ce qui met l'application à jour toute seule.
let swCache = null;
function serviceWorker() {
  if (swCache) return swCache;
  const pub = path.resolve('public');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const files = ['js', 'css', 'icons', 'img'].flatMap((d) => walk(path.join(pub, d)))
    .filter((f) => !/[\\/](suivi)\.(js|css)$/.test(f))
    .map((f) => '/' + path.relative(pub, f).split(path.sep).join('/'));
  const urls = ['/', '/kiosk.html', '/installer.html', '/manifest.webmanifest', '/kiosk.webmanifest', '/vendor/vue.js', '/vendor/marked.js', '/vendor/purify.js', '/vendor/icons.js', '/vendor/fonts/inter.woff2', '/vendor/fonts/space-grotesk.woff2', '/vendor/fonts/instrument-serif.woff2', ...files];
  const hash = crypto.createHash('sha1');
  const src = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
  hash.update(src);
  for (const f of [...['index.html', 'kiosk.html', 'installer.html', 'manifest.webmanifest', 'kiosk.webmanifest'].map((n) => path.join(pub, n)), ...files.map((u) => path.join(pub, u)), nm('vue/package.json'), nm('lucide/package.json')]) {
    try { hash.update(f + ':' + fs.readFileSync(f).length + ':' + crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')); } catch {}
  }
  hash.update(ICONS.join());
  swCache = src
    .replace(/const CACHE = '[^']*';/, `const CACHE = 'garage-${hash.digest('hex').slice(0, 12)}';`)
    .replace(/const PRECACHE = \[\];/, `const PRECACHE = ${JSON.stringify(urls)};`);
  return swCache;
}
app.get('/sw.js', (req, res) => res.type('application/javascript').set('Cache-Control', 'no-cache').send(serviceWorker()));
// Informations publiques pour la page d'installation (aucune donnée sensible)
app.get('/app-info.json', (req, res) => {
  const s = getSettings();
  res.json({ company: s.company.name, logo: s.layout?.logo_version ? `/logo?v=${s.layout.logo_version}` : null, secure_url: secureUrl(req), secure: req.secure });
});

// ---------- Site web public ----------
const siteHeaders = (res) => res.set('X-Content-Type-Options', 'nosniff').set('Referrer-Policy', 'strict-origin-when-cross-origin');
app.get('/site', (req, res) => {
  siteHeaders(res);
  if (!websiteConfig().published) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Bientôt en ligne</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;color:#334155"><h1>🔧 Site bientôt en ligne</h1></body>');
  res.type('html').send(renderSite());
});
app.get('/site-media/:file', (req, res) => {
  const f = siteMediaFile(req.params.file);
  if (!f) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400').set('X-Content-Type-Options', 'nosniff').sendFile(f);
});
app.post('/site-api/contact', (req, res) => {
  try { res.json(submitContact(req.body || {}, req.ip)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/home-bg', (req, res) => {
  const l = logoFile('home');
  if (!l) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=300').set('X-Content-Type-Options', 'nosniff').type(l.type).sendFile(l.file);
});
// Logo public (affiché sur les factures, les e-mails et la page de suivi client)
app.get('/logo', (req, res) => {
  const l = logoFile();
  if (!l) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=300').set('X-Content-Type-Options', 'nosniff').type(l.type).sendFile(l.file);
});
app.use(express.static(path.resolve('public')));

const api = express.Router({ caseSensitive: true });
app.use('/api', api);
// Aucune adresse de l'API ne contient de caractère encodé (« %31 » pour « 1 »…) : on les refuse, car les règles de droits
// lisent l'adresse telle qu'elle est écrite alors que le serveur la décode ensuite
api.use((req, res, next) => (req.path.includes('%') ? res.status(400).json({ error: 'Adresse invalide' }) : next()));
// Un identifiant de fiche est toujours un nombre (/customers/abc n'existe pas ; sans ce contrôle, « abc » pouvait créer une nouvelle fiche)
api.param('id', (req, res, next, v) => (/^\d{1,15}$/.test(v) || /^\/agents\//.test(req.path) ? next() : res.status(404).json({ error: 'Introuvable' })));
// Une requête sans corps (ou avec un corps qui n'est pas un objet JSON) est traitée comme un formulaire vide
api.use((req, res, next) => { if (req.body === undefined || req.body === null) req.body = {}; next(); });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).then((r) => { if (r !== undefined && !res.headersSent) res.json(r); }).catch(next);
const staff = requireAuth(['admin', 'office']);
const adminOnly = requireAuth(['admin']);

// ---------- Accès depuis internet (serveur en ligne, tunnel) ----------
// Requête venant de l'ordinateur lui-même, du réseau du garage ou de Tailscale (privé) — et non de l'internet public.
// Derrière Caddy, Tailscale ou Cloudflare, req.ip est l'adresse réelle du visiteur (voir « trust proxy »).
function isLocalRequest(req) {
  if (process.env.INTERNET_SERVER === '1' || req.get('cf-connecting-ip') || req.get('tailscale-funnel-request')) return false;
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  return ip === '::1' || /^(127|10)\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || /^f[cd][0-9a-f]{0,2}:/i.test(ip) || /^fe80:/i.test(ip);
}
// Première configuration depuis internet : un code affiché dans le journal du serveur est demandé,
// pour qu'un inconnu ne puisse pas créer le compte gérant d'un serveur tout juste mis en ligne.
// Le code est gardé dans le dossier des données : il reste le même après un redémarrage, jusqu'à la création du compte.
const SETUP_FILE = path.join(dataDir, 'setup-code.txt');
const SETUP_CODE = (() => {
  if (get("SELECT COUNT(*) n FROM users WHERE role='admin'").n > 0) return crypto.randomBytes(5).toString('hex').toUpperCase().replace(/^(.{5})/, '$1-');
  try { const c = fs.readFileSync(SETUP_FILE, 'utf8').trim(); if (/^[0-9A-F]{5}-[0-9A-F]{5}$/.test(c)) return c; } catch {}
  const c = crypto.randomBytes(5).toString('hex').toUpperCase().replace(/^(.{5})/, '$1-');
  try { fs.writeFileSync(SETUP_FILE, c, { mode: 0o600 }); } catch {}
  return c;
})();
const sameCode = (a, b) => {
  const x = Buffer.from(String(a || '').toUpperCase().replace(/[^0-9A-F]/g, '')), y = Buffer.from(b.replace(/-/g, ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
// Anti-devinette des mots de passe sur 15 minutes : 10 échecs max. par adresse et, depuis internet, 20 par compte
const fails = new Map();
const FAIL_WINDOW = 15 * 60_000;
function guard(keys, max = 10) {
  const now = Date.now();
  for (const k of keys) {
    const e = fails.get(k);
    if (e && now - e.t < FAIL_WINDOW && e.n >= (k.startsWith('acct:') ? 2 * max : max)) throw new BusinessError('Trop d\'essais. Réessayez dans 15 minutes.', 429);
  }
}
function failed(keys) {
  const now = Date.now();
  for (const k of keys) { const e = fails.get(k); if (!e || now - e.t >= FAIL_WINDOW) fails.set(k, { n: 1, t: now }); else e.n++; }
}
setInterval(() => { const now = Date.now(); for (const [k, e] of fails) if (now - e.t >= FAIL_WINDOW) fails.delete(k); }, 60_000).unref();
// Appareil déjà connecté à ce compte (cookie signé, 1 an) : une attaque sur le compte ne le bloque pas
let deviceKey;
function deviceTag(userId) {
  if (!deviceKey) {
    const f = path.join(dataDir, 'device.key');
    try { deviceKey = fs.readFileSync(f, 'utf8').trim(); } catch {}
    if (!deviceKey || deviceKey.length < 32) { deviceKey = crypto.randomBytes(32).toString('hex'); try { fs.writeFileSync(f, deviceKey, { mode: 0o600 }); } catch {} }
  }
  return crypto.createHmac('sha256', deviceKey).update('device:' + userId).digest('hex');
}
const rememberDevice = (req, res, userId) => res.cookie('gdevice', deviceTag(userId), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 365 * 86400e3 });
const knownDevice = (req, userId) => {
  const c = /(?:^|;\s*)gdevice=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
  return !!c && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(deviceTag(userId)));
};
// Clés de comptage : l'adresse, et depuis internet le compte (empreinte de taille fixe, jamais l'e-mail reçu tel quel)
const loginKeys = (req, email, known) => (isLocalRequest(req) || known ? [`ip:${req.ip}`]
  : [`ip:${req.ip}`, 'acct:' + crypto.createHash('sha256').update(email).digest('hex')]);

// ---------- Authentification ----------
api.get('/auth/status', (req, res) => {
  const needsSetup = get('SELECT COUNT(*) n FROM users WHERE role=?', 'admin').n === 0;
  // (le jeton de session reste dans le cookie protégé : il n'est jamais renvoyé dans la page)
  const u = currentUser(req);
  const user = u ? { id: u.id, name: u.name, email: u.email, role: u.role, color: u.color, job_title: u.job_title, session_kind: u.session_kind } : null;
  res.json({ needsSetup, setupCode: needsSetup && !isLocalRequest(req), user, company: getSettings().company.name, ai: aiConfigured() });
});
api.post('/auth/setup', wrap((req, res) => {
  if (get("SELECT COUNT(*) n FROM users WHERE role='admin'").n > 0) throw new BusinessError('Déjà configuré', 403);
  if (!isLocalRequest(req)) {
    guard([`setup:${req.ip}`]);
    if (!sameCode(req.body.setup_code, SETUP_CODE)) { failed([`setup:${req.ip}`]); throw new BusinessError('Code d\'installation incorrect (il est affiché dans le journal du serveur)', 403); }
  }
  const { company } = req.body;
  const name = String(req.body.name || '').trim(), email = String(req.body.email || '').trim().toLowerCase(), password = String(req.body.password || '');
  if (!name || !/^\S+@\S+$/.test(email) || password.length < 8) throw new BusinessError('Nom, e-mail et mot de passe (8 caractères min.) requis');
  const id = insert('users', { name, email, role: 'admin', password_hash: hashSecret(password) }, ['name', 'email', 'role', 'password_hash']);
  if (company) setSetting('company', { ...getSettings().company, name: company });
  try { fs.rmSync(SETUP_FILE, { force: true }); } catch {}
  const token = createSession(id);
  res.cookie('gsession', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 86400e3 });
  rememberDevice(req, res, id);
  return { token };
}));
api.post('/auth/login', wrap((req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (email.length > 254) throw new BusinessError('Identifiants incorrects', 401);
  const u = get('SELECT * FROM users WHERE email=? AND active=1', email);
  const keys = loginKeys(req, email, u && knownDevice(req, u.id));
  guard(keys);
  // Échecs de CETTE adresse sur CE compte : eux seuls sont pardonnés par une connexion réussie
  // (se connecter à son propre compte ne remet pas à zéro les essais faits sur le compte d'un collègue)
  const pair = `pair:${req.ip}:${crypto.createHash('sha256').update(email).digest('hex').slice(0, 16)}`;
  if (!u || u.role === 'mechanic' || !verifySecret(req.body.password || '', u.password_hash)) { failed([...keys, pair]); throw new BusinessError('Identifiants incorrects', 401); }
  const mine = fails.get(pair)?.n || 0, ipEntry = fails.get(keys[0]);
  if (ipEntry && mine) { ipEntry.n -= mine; if (ipEntry.n <= 0) fails.delete(keys[0]); }
  fails.delete(pair);
  run('UPDATE users SET last_login=CURRENT_TIMESTAMP WHERE id=?', u.id);
  const token = createSession(u.id);
  res.cookie('gsession', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 86400e3 });
  rememberDevice(req, res, u.id);
  return { token };
}));
// Invitation : la personne invitée choisit son mot de passe
api.get('/auth/invite/:token', wrap((req) => {
  const u = findInvite(req.params.token);
  if (!u) throw new BusinessError('Invitation invalide ou expirée. Demandez un nouveau lien au gérant.', 404);
  return { name: u.name, email: u.email, company: getSettings().company.name };
}));
api.post('/auth/invite/:token', wrap((req, res) => {
  const u = findInvite(req.params.token);
  if (!u) throw new BusinessError('Invitation invalide ou expirée. Demandez un nouveau lien au gérant.', 404);
  const pw = String(req.body.password || '');
  if (pw.length < 8) throw new BusinessError('Mot de passe : 8 caractères minimum');
  run('UPDATE users SET password_hash=?, last_login=CURRENT_TIMESTAMP WHERE id=?', hashSecret(pw), u.id);
  clearInvite(u.id);
  run('DELETE FROM sessions WHERE user_id=?', u.id);
  const token = createSession(u.id);
  res.cookie('gsession', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 86400e3 });
  rememberDevice(req, res, u.id);
  return { token };
}));
api.post('/auth/logout', (req, res) => {
  const u = currentUser(req);
  if (u) run('DELETE FROM sessions WHERE token=?', u.token);
  res.clearCookie('gsession');
  res.json({ ok: true });
});

// ---------- Kiosque mécaniciens (pointage) ----------
api.get('/kiosk/users', (req, res) => {
  const cfg = attendanceConfig();
  res.json({
    company: getSettings().company.name, logo: getSettings().layout?.logo_version ? `/logo?v=${getSettings().layout.logo_version}` : null,
    pin: cfg.kiosk_pin || !isLocalRequest(req), badge: cfg.kiosk_badge && isLocalRequest(req),
    // hors du réseau du garage : les prénoms seulement (ni fonction, ni « présent depuis »)
    users: all(`SELECT u.id, u.name, u.color, u.role, u.job_title,
      (SELECT start FROM time_entries t WHERE t.user_id=u.id AND t.kind='presence' AND t.end IS NULL LIMIT 1) AS since
      FROM users u WHERE u.active=1 AND (u.pin_hash IS NOT NULL OR u.role='mechanic') ORDER BY u.name`)
      .map((u) => (isLocalRequest(req) ? u : { id: u.id, name: u.name, color: u.color, role: u.role, since: null })),
  });
});
// Tentatives de PIN limitées (anti-devinette) : 5 essais par personne et par 5 minutes
const pinTries = new Map();
// (compteur séparé pour le réseau du garage : des essais venus d'internet ne bloquent jamais la tablette de l'atelier)
function checkPin(u, pin, origin = 'lan') {
  const k = `${u.id}:${origin}`;
  const now = Date.now();
  const e = pinTries.get(k) || { n: 0, t: now };
  if (now - e.t > 300_000) { e.n = 0; e.t = now; }
  if (e.n >= 5) throw new BusinessError('Trop d\'essais. Réessayez dans quelques minutes.', 429);
  if (!verifySecret(pin || '', u.pin_hash)) { e.n++; pinTries.set(k, e); throw new BusinessError('Code PIN incorrect', 401); }
  pinTries.delete(k);
}
api.post('/kiosk/login', wrap((req) => {
  const u = get('SELECT * FROM users WHERE id=? AND active=1', req.body.user_id);
  if (!u) throw new BusinessError('Personne inconnue', 404);
  // Depuis internet, le code PIN est toujours obligatoire (sinon n'importe qui verrait les OR de l'atelier)
  const local = isLocalRequest(req);
  if (attendanceConfig().kiosk_pin || u.role !== 'mechanic' || !local) {
    if (!u.pin_hash) throw new BusinessError(local ? 'Aucun code PIN : le gérant doit en créer un dans Paramètres → Utilisateurs' : 'Hors du réseau du garage, un code PIN est obligatoire : le gérant doit en créer un dans Paramètres → Utilisateurs', 401);
    // Depuis internet : en plus de la limite par personne, 10 codes faux max. par adresse et par quart d'heure
    if (!local) guard([`kiosk:${req.ip}`]);
    try { checkPin(u, req.body.pin, local ? 'lan' : req.ip); } catch (e) { if (!local && e.status === 401) failed([`kiosk:${req.ip}`]); throw e; }
  }
  return { token: createSession(u.id, 'kiosk'), user: { id: u.id, name: u.name, color: u.color, role: u.role } };
}));
// Badge (lecteur de code-barres / carte) : arrivée ou départ direct, comme Odoo
api.post('/kiosk/badge', wrap((req) => {
  if (!attendanceConfig().kiosk_badge) throw new BusinessError('Badges désactivés', 403);
  // Le badge remplace le code PIN : il n'est accepté que sur le réseau du garage
  if (!isLocalRequest(req)) throw new BusinessError('Le badge ne fonctionne que sur le réseau du garage', 403);
  const badge = String(req.body.badge || '').trim();
  guard([`badge:${req.ip}`], 20);
  const u = badge.length >= 3 ? get('SELECT id FROM users WHERE badge=? AND active=1', badge) : null;
  if (!u) { failed([`badge:${req.ip}`]); throw new BusinessError('Badge inconnu', 404); }
  return checkInOut(u.id, { source: 'badge' });
}));
const mech = requireAuth(['mechanic', 'admin', 'office']);
function kioskState(userId) {
  const presence = get("SELECT * FROM time_entries WHERE user_id=? AND kind='presence' AND end IS NULL", userId);
  const work = get(`SELECT t.*, d.number, v.plate, l.description AS line_description FROM time_entries t LEFT JOIN documents d ON d.id=t.document_id LEFT JOIN vehicles v ON v.id=d.vehicle_id
    LEFT JOIN document_lines l ON l.id=t.line_id AND l.document_id=t.document_id
    WHERE t.user_id=? AND t.kind='work' AND t.end IS NULL ORDER BY t.start DESC LIMIT 1`, userId);
  const orders = all(`SELECT d.id, d.number, d.status, d.customer_complaint, d.diagnosis, d.promised_at, d.mechanic_id, v.plate, v.make, v.model, v.vin, d.mileage,
      c.name AS customer_name FROM documents d LEFT JOIN vehicles v ON v.id=d.vehicle_id LEFT JOIN customers c ON c.id=d.customer_id
    WHERE d.type='order' AND d.status IN ('open','in_progress','waiting_parts') ORDER BY (d.mechanic_id=?) DESC, d.promised_at, d.id`, userId);
  // Chaque intervention avec son temps prévu, le temps déjà passé et les chronos en cours
  const now = localDateTime();
  for (const o of orders) Object.assign(o, kioskLines(o.id, now));
  const dayStart = `${today()}T00:00:00`;
  const todayHours = round2(all("SELECT * FROM time_entries WHERE user_id=? AND kind='work' AND start>=?", userId, dayStart).reduce((s, t) => s + durationHours(t), 0));
  return { presence, work, orders, todayHours };
}
// Les OR sont réservés aux mécaniciens et, si l'option est active, aux personnes du bureau qui ont le droit Atelier
const seesOrders = (u) => u.role === 'mechanic' || (attendanceConfig().kiosk_show_orders && can(u, 'atelier', 'read'));
const worksOrders = (req, res, next) => (req.user.role === 'mechanic' || can(req.user, 'atelier', 'user') ? next() : res.status(403).json({ error: 'Il faut le droit « Utilisateur » sur Atelier pour travailler sur un OR' }));
const fullKioskState = (u) => {
  const show = seesOrders(u);
  const s = kioskState(u.id);
  return { ...s, orders: show ? s.orders : [], attendance: statusOf(u.id), show_orders: show };
};
api.get('/kiosk/state', mech, (req, res) => res.json(fullKioskState(req.user)));
api.post('/kiosk/attendance', mech, wrap((req) => checkInOut(req.user.id, { action: req.body.action, source: 'kiosk' })));
function stopWork(userId, now) {
  run("UPDATE time_entries SET end=? WHERE user_id=? AND kind='work' AND end IS NULL", now, userId);
}
/**
 * Démarre le chrono d'une personne sur un OR, ou sur une de ses interventions (ligne de main-d'œuvre ou forfait).
 * Une personne n'est pointée que sur UN travail à la fois : le chrono qui tournait ailleurs est arrêté d'office
 * (« switched » dit lequel, pour le lui afficher). Utilisé par la tablette de l'atelier et par la fiche de l'OR au bureau.
 */
function startWork(uid, documentId, lineRef, note) {
  const now = localDateTime();
  let resumed = null, reopened = null, switched = null;
  tx(() => {
    const d = get("SELECT id, number, status, mechanic_id FROM documents WHERE id=? AND type='order'", Number(documentId) || 0);
    if (!d) throw new BusinessError('OR introuvable');
    if (['invoiced', 'cancelled'].includes(d.status)) throw new BusinessError('Cet OR est clôturé');
    // Chrono sur une intervention précise ; sans ligne : sur l'OR entier
    let lineId = null;
    if (lineRef !== undefined && lineRef !== null && lineRef !== '') {
      const l = Number.isInteger(Number(lineRef)) ? get('SELECT id, kind, done FROM document_lines WHERE id=? AND document_id=?', Number(lineRef), d.id) : null;
      if (!isIntervention(l)) throw new BusinessError('Intervention introuvable sur cet OR');
      lineId = l.id;
      // Reprise d'une intervention déjà cochée « fait » : elle redevient « à faire » (sinon elle resterait cochée, chrono en marche)
      if (l.done) { run('UPDATE document_lines SET done=0 WHERE id=?', l.id); touchDocument(d.id); reopened = d.id; }
    }
    if (!get("SELECT id FROM time_entries WHERE user_id=? AND kind='presence' AND end IS NULL", uid)) insert('time_entries', { user_id: uid, kind: 'presence', start: now }, ['user_id', 'kind', 'start']);
    const running = get(`SELECT t.document_id, t.line_id, r.number, l.description AS line FROM time_entries t LEFT JOIN documents r ON r.id=t.document_id
      LEFT JOIN document_lines l ON l.id=t.line_id AND l.document_id=t.document_id WHERE t.user_id=? AND t.kind='work' AND t.end IS NULL ORDER BY t.start DESC LIMIT 1`, uid);
    // Déjà en cours sur ce même travail : le chrono continue (un second appui ne le découpe pas)
    if (!(running && running.document_id === d.id && (running.line_id || null) === lineId)) {
      if (running) switched = { document_id: running.document_id, number: running.number, line: running.line, same_order: running.document_id === d.id, to: d.number };
      stopWork(uid, now);
      insert('time_entries', { user_id: uid, kind: 'work', document_id: d.id, line_id: lineId, start: now, note: typeof note === 'string' ? note.slice(0, 500) : undefined }, ['user_id', 'kind', 'document_id', 'line_id', 'start', 'note']);
    }
    // Démarrer le travail remet l'OR « En cours » (aussi après une attente de pièces)
    if (d.status === 'open' || d.status === 'waiting_parts') { run("UPDATE documents SET status='in_progress', mechanic_id=COALESCE(mechanic_id, ?) WHERE id=?", uid, d.id); if (!d.mechanic_id) touchDocument(d.id); resumed = d.id; }
  });
  if (resumed) stageFromStatus(resumed, 'in_progress');
  else if (reopened) livePublish(reopened);
  return { switched };
}
api.post('/kiosk/clock', mech, wrap((req) => {
  const now = localDateTime();
  const uid = req.user.id;
  const { action, document_id, note } = req.body;
  let switched = null;
  if (action === 'start') {
    if (req.user.role !== 'mechanic' && !can(req.user, 'atelier', 'user')) throw new BusinessError('Il faut le droit « Utilisateur » sur Atelier pour travailler sur un OR', 403);
    ({ switched } = startWork(uid, document_id, req.body.line_id, note));
  } else {
    tx(() => {
      if (action === 'in') {
        if (!get("SELECT id FROM time_entries WHERE user_id=? AND kind='presence' AND end IS NULL", uid)) insert('time_entries', { user_id: uid, kind: 'presence', start: now }, ['user_id', 'kind', 'start']);
      } else if (action === 'out') {
        stopWork(uid, now);
        run("UPDATE time_entries SET end=? WHERE user_id=? AND kind='presence' AND end IS NULL", now, uid);
      } else if (action === 'stop') {
        stopWork(uid, now);
      } else throw new BusinessError('Action inconnue');
    });
  }
  // « switched » : le chrono qui tournait sur un autre travail vient d'être arrêté (affiché au mécanicien)
  return { ...fullKioskState(req.user), switched };
}));
api.post('/kiosk/orders/:id', mech, worksOrders, wrap((req) => {
  const id = Number(req.params.id);
  const d = get("SELECT * FROM documents WHERE id=? AND type='order'", id);
  if (!d || d.status === 'invoiced') throw new BusinessError('OR non modifiable');
  const { line_id, done, status } = req.body;
  // textes venant de la tablette : toujours traités comme du texte
  const text = (v, label) => { if (v === undefined || v === null) return undefined; if (typeof v !== 'string') throw new BusinessError(`${label} invalide`); return v.slice(0, 5000); };
  const diagnosis = text(req.body.diagnosis, 'Diagnostic'), note = text(req.body.note, 'Note');
  if (line_id !== undefined && !Number.isInteger(Number(line_id))) throw new BusinessError('Ligne invalide');
  let mileage = null;
  if (!blank(req.body.mileage)) {
    mileage = Number(req.body.mileage);
    if (!Number.isInteger(mileage) || mileage < 0 || mileage > 9_999_999) throw new BusinessError('Kilométrage invalide');
  }
  // (le document n'est marqué « modifié » que si une saisie que le bureau pourrait écraser a changé — pas pour un simple changement de statut)
  if (line_id !== undefined || diagnosis !== undefined || mileage || note) touchDocument(id);
  if (line_id !== undefined) {
    run('UPDATE document_lines SET done=? WHERE id=? AND document_id=?', done ? 1 : 0, line_id, id);
    if (done) stopLineTimers(id, Number(line_id)); // intervention terminée : son chrono s'arrête
  }
  if (diagnosis !== undefined) run('UPDATE documents SET diagnosis=? WHERE id=?', diagnosis, id);
  if (mileage) { run('UPDATE documents SET mileage=? WHERE id=?', mileage, id); if (d.vehicle_id) run('UPDATE vehicles SET mileage=MAX(COALESCE(mileage,0),?) WHERE id=?', mileage, d.vehicle_id); }
  if (note) run("UPDATE documents SET internal_notes=COALESCE(internal_notes,'') || ? WHERE id=?", `\n[${req.user.name} ${localDateTime().slice(0, 16).replace('T', ' ')}] ${note}`, id);
  if (status && ['in_progress', 'waiting_parts', 'done'].includes(status)) {
    run('UPDATE documents SET status=? WHERE id=?', status, id);
    if (status === 'done') stopOrderTimers(id);
    stageFromStatus(id, status);
  } else if (line_id !== undefined || diagnosis !== undefined || mileage || note) livePublish(id);
  return fullKioskState(req.user);
}));
// Lien "photos & messages" du mécanicien pour un OR
api.post('/kiosk/orders/:id/live', mech, worksOrders, wrap((req) => ({ url: `/suivi.html?t=${ensureLink(Number(req.params.id), 'mechanic')}` })));

// ---------- Tout le reste nécessite une connexion bureau ----------
api.use((req, res, next) => (req.path.startsWith('/kiosk') || req.path.startsWith('/auth') ? next() : staff(req, res, next)));
api.use((req, res, next) => (req.path.startsWith('/kiosk') || req.path.startsWith('/auth') ? next() : accessGuard(req, res, next)));
const needManager = (app) => (req, res, next) => (can(req.user, app, 'manager') ? next() : res.status(403).json({ error: 'Réservé aux administrateurs de cette application' }));

api.get('/dashboard', (req, res) => res.json(maskDashboard(dashboard(), req.user)));
// Adresses du PC sur le réseau local (pour ouvrir le logiciel sur téléphone / tablette)
api.get('/network', (req, res) => {
  const port = process.env.PORT || 3000;
  // Sur un serveur internet (Docker), les adresses internes du conteneur ne servent à rien aux téléphones
  const internet = process.env.INTERNET_SERVER === '1';
  res.json({ lan: internet ? [] : lanUrls(port), internet_server: internet, secure_url: secureUrl(req), current: `${req.protocol}://${req.get('host')}`, is_https: req.secure, port: Number(port) });
});
api.get('/search', (req, res) => {
  const q = likeFold(req.query.q || '');
  const plate = likeFold(String(req.query.q || '').replace(/\s/g, ''));
  const u = req.user;
  // Documents : seulement les types que l'utilisateur a le droit de voir (filtré AVANT la limite de 8 résultats)
  const docTypes = [can(u, 'ventes') ? "d.type!='order'" : null, can(u, 'atelier') ? "d.type='order'" : null].filter(Boolean);
  res.json({
    customers: !can(u, 'contacts') ? [] : all(`SELECT id, name, company, phone, city FROM customers WHERE fold(name) LIKE ? ESCAPE '\\' OR fold(company) LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR mobile LIKE ? ESCAPE '\\' OR fold(email) LIKE ? ESCAPE '\\' LIMIT 8`, q, q, q, q, q),
    vehicles: !can(u, 'vehicules') ? [] : all(`SELECT v.id, v.plate, v.make, v.model, c.name AS customer_name FROM vehicles v LEFT JOIN customers c ON c.id=v.customer_id WHERE fold(REPLACE(v.plate,' ','')) LIKE ? ESCAPE '\\' OR fold(v.vin) LIKE ? ESCAPE '\\' OR fold(v.model) LIKE ? ESCAPE '\\' LIMIT 8`, plate, q, q),
    documents: !docTypes.length ? [] : all(`SELECT d.id, d.type, d.number, d.status, d.total, c.name AS customer_name FROM documents d LEFT JOIN customers c ON c.id=d.customer_id WHERE (fold(d.number) LIKE ? ESCAPE '\\' OR fold(d.reference) LIKE ? ESCAPE '\\') AND (${docTypes.join(' OR ')}) ORDER BY d.id DESC LIMIT 8`, q, q),
    products: !can(u, 'inventaire') ? [] : all(`SELECT id, ref, name, qty_on_hand, sale_price FROM products WHERE fold(ref) LIKE ? ESCAPE '\\' OR fold(name) LIKE ? ESCAPE '\\' OR ean LIKE ? ESCAPE '\\' LIMIT 8`, q, q, q),
  });
});

// ---------- CRUD générique ----------
const FIELD_LABELS = { name: 'Nom', start: 'Début', end: 'Fin', payment_terms: 'Délai de paiement', year: 'Année', mileage: 'Kilométrage', next_service_km: 'Prochain entretien (km)',
  first_registration: 'Première immatriculation', next_inspection: 'Contrôle technique', next_service_date: 'Prochain entretien', purchase_price: 'Prix d\'achat', sale_price: 'Prix de vente',
  tax_rate: 'TVA', qty_min: 'Stock minimum', labor_hours: 'Temps barème', opening_balance: 'Solde initial', customer_id: 'Client', vehicle_id: 'Véhicule', supplier_id: 'Fournisseur', mechanic_id: 'Mécanicien', document_id: 'Document' };
const label = (k) => FIELD_LABELS[k] || k;
const blank = (v) => v === undefined || v === null || v === '';
/**
 * Contrôle d'un formulaire avant l'enregistrement : champs obligatoires, vrais nombres (virgule acceptée),
 * vraies dates, fiches liées existantes. Une erreur claire en français plutôt qu'une erreur technique.
 */
function cleanBody(body, { required = [], numbers = [], dates = [], datetimes = [], refs = {} } = {}, creating) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BusinessError('Données manquantes');
  const d = { ...body };
  for (const k of required) {
    if (typeof d[k] === 'string') d[k] = d[k].trim();
    if (creating ? blank(d[k]) : k in d && blank(d[k])) throw new BusinessError(`Champ obligatoire : ${label(k)}`);
    if (!blank(d[k]) && typeof d[k] !== 'string') d[k] = String(d[k]);
  }
  for (const k of numbers) {
    if (!(k in d)) continue;
    if (blank(d[k])) { d[k] = null; continue; }
    const n = typeof d[k] === 'string' ? Number(d[k].trim().replace(',', '.')) : Number(d[k]);
    if (!Number.isFinite(n) || typeof d[k] === 'object') throw new BusinessError(`${label(k)} : nombre invalide`);
    d[k] = n;
  }
  for (const k of dates) if (!blank(d[k]) && !isDate(d[k])) throw new BusinessError(`${label(k)} : date invalide`);
  for (const k of datetimes) if (!blank(d[k]) && !validDateTime(d[k])) throw new BusinessError(`${label(k)} : date ou heure invalide`);
  for (const [k, table] of Object.entries(refs)) if (!blank(d[k]) && !get(`SELECT 1 FROM ${table} WHERE id=?`, d[k])) throw new BusinessError(`${label(k)} introuvable`);
  return d;
}
/** Efface ce qui était attaché à une fiche supprimée (sinon la fiche suivante, qui reprend son numéro, en hériterait). */
function forgetRecord(model, id) {
  for (const a of listAttachments(model, id)) deleteAttachment(a.id);
  run('DELETE FROM messages WHERE model=? AND record_id=?', model, id);
  run('DELETE FROM activities WHERE model=? AND record_id=?', model, id);
  run("UPDATE emails SET status='cancelled' WHERE model=? AND record_id=? AND status='scheduled'", model, id);
  run('UPDATE emails SET model=NULL, record_id=NULL WHERE model=? AND record_id=?', model, id);
}
function crud(name, table, columns, { list, detail, beforeSave, spec, check, model } = {}) {
  const prepare = (req, creating) => {
    let d = cleanBody(req.body, spec, creating);
    if (beforeSave) d = beforeSave(d);
    if (check) check(d, creating ? null : get(`SELECT * FROM ${table} WHERE id=?`, req.params.id));
    return d;
  };
  api.get(`/${name}`, (req, res) => res.json(list ? list(req) : all(`SELECT * FROM ${table} ORDER BY id DESC`)));
  api.get(`/${name}/:id`, wrap((req) => {
    const r = detail ? detail(Number(req.params.id), req) : get(`SELECT * FROM ${table} WHERE id=?`, req.params.id);
    if (!r) throw new BusinessError('Introuvable', 404);
    return r;
  }));
  api.post(`/${name}`, wrap((req) => ({ id: insert(table, prepare(req, true), columns) })));
  api.put(`/${name}/:id`, wrap((req) => {
    if (!get(`SELECT 1 FROM ${table} WHERE id=?`, req.params.id)) throw new BusinessError('Introuvable', 404);
    update(table, req.params.id, prepare(req, false), columns);
    return { id: Number(req.params.id) };
  }));
  api.delete(`/${name}/:id`, wrap((req) => {
    try {
      tx(() => { run(`DELETE FROM ${table} WHERE id=?`, req.params.id); if (model) forgetRecord(model, Number(req.params.id)); });
    } catch (e) { if (e instanceof BusinessError) throw e; throw new BusinessError('Suppression impossible : cet élément est utilisé ailleurs.'); }
    return { ok: true };
  }));
}

// Devis, factures et avoirs : droit Ventes ; ordres de réparation : droit Atelier (aussi sur les fiches client et véhicule)
const docVisible = (u) => (d) => can(u, d.type === 'order' ? 'atelier' : 'ventes');
const upperPlate = (b) => ({ ...b, plate: b.plate ? String(b.plate).toUpperCase().trim() : b.plate, vin: b.vin ? String(b.vin).toUpperCase().trim() : b.vin });

crud('customers', 'customers', ['type', 'name', 'company', 'vat_number', 'email', 'phone', 'mobile', 'address', 'zip', 'city', 'country', 'payment_terms', 'notes', 'marketing_ok'], {
  model: 'customer', spec: { required: ['name'], numbers: ['payment_terms'] },
  list: (req) => {
    const q = likeFold(req.query.q || '');
    // le solde impayé n'est montré qu'avec le droit Ventes
    return all(`SELECT c.*, (SELECT COUNT(*) FROM vehicles WHERE customer_id=c.id) AS vehicle_count,
      ${can(req.user, 'ventes') ? "(SELECT ROUND(SUM(total-amount_paid),2) FROM documents WHERE customer_id=c.id AND type='invoice' AND status IN ('posted','partial'))" : 'NULL'} AS balance
      FROM customers c WHERE fold(c.name) LIKE ? ESCAPE '\\' OR fold(c.company) LIKE ? ESCAPE '\\' OR fold(c.email) LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR c.mobile LIKE ? ESCAPE '\\' ORDER BY c.name LIMIT 500`, q, q, q, q, q);
  },
  detail: (id, req) => {
    const c = get('SELECT * FROM customers WHERE id=?', id);
    if (!c) return null;
    c.vehicles = can(req.user, 'vehicules') ? all('SELECT * FROM vehicles WHERE customer_id=? ORDER BY id DESC', id) : [];
    c.documents = all('SELECT d.id, d.type, d.number, d.status, d.date, d.total, d.amount_paid, v.plate FROM documents d LEFT JOIN vehicles v ON v.id=d.vehicle_id WHERE d.customer_id=? ORDER BY d.id DESC', id)
      .filter(docVisible(req.user));
    return c;
  },
});
crud('vehicles', 'vehicles', ['customer_id', 'plate', 'vin', 'make', 'model', 'version', 'fuel', 'year', 'first_registration', 'mileage', 'color', 'engine_code', 'tyre_size', 'next_inspection', 'next_service_date', 'next_service_km', 'notes'], {
  beforeSave: upperPlate, model: 'vehicle',
  spec: { numbers: ['year', 'mileage', 'next_service_km'], dates: ['first_registration', 'next_inspection', 'next_service_date'], refs: { customer_id: 'customers' } },
  list: (req) => {
    const q = likeFold(req.query.q || '');
    // la plaque se retrouve avec ou sans espace (« AB1234 » trouve « AB 1234 »)
    return all(`SELECT v.*, c.name AS customer_name FROM vehicles v LEFT JOIN customers c ON c.id=v.customer_id
      WHERE fold(v.plate) LIKE ? ESCAPE '\\' OR fold(REPLACE(v.plate,' ','')) LIKE ? ESCAPE '\\' OR fold(v.vin) LIKE ? ESCAPE '\\' OR fold(v.make) LIKE ? ESCAPE '\\' OR fold(v.model) LIKE ? ESCAPE '\\' OR fold(c.name) LIKE ? ESCAPE '\\' ORDER BY v.id DESC LIMIT 500`,
    q, likeFold(String(req.query.q || '').replace(/\s/g, '')), q, q, q, q);
  },
  detail: (id, req) => {
    const v = get('SELECT v.*, c.name AS customer_name FROM vehicles v LEFT JOIN customers c ON c.id=v.customer_id WHERE v.id=?', id);
    if (!v) return null;
    v.history = all(`SELECT d.id, d.type, d.number, d.status, d.date, d.mileage, d.total, d.customer_complaint,
      (SELECT GROUP_CONCAT(description, ' · ') FROM document_lines WHERE document_id=d.id AND kind!='text') AS summary
      FROM documents d WHERE d.vehicle_id=? ORDER BY d.date DESC, d.id DESC`, id).filter(docVisible(req.user));
    return v;
  },
});
crud('suppliers', 'suppliers', ['name', 'vat_number', 'email', 'phone', 'address', 'zip', 'city', 'country', 'iban', 'website', 'default_account', 'notes'], {
  model: 'supplier', spec: { required: ['name'] },
  list: () => all(`SELECT s.*, (SELECT ROUND(SUM(total-amount_paid),2) FROM purchases WHERE supplier_id=s.id AND posted=1 AND status!='paid') AS balance FROM suppliers s ORDER BY name`),
});
crud('products', 'products', ['ref', 'ean', 'name', 'category', 'brand', 'supplier_id', 'purchase_price', 'sale_price', 'tax_rate', 'qty_min', 'location', 'unit', 'is_service', 'labor_hours', 'active'], {
  model: 'product', spec: { required: ['name'], numbers: ['purchase_price', 'sale_price', 'tax_rate', 'qty_min', 'labor_hours'], refs: { supplier_id: 'suppliers' } },
  list: (req) => {
    const q = likeFold(req.query.q || '');
    return all(`SELECT p.*, s.name AS supplier_name FROM products p LEFT JOIN suppliers s ON s.id=p.supplier_id
      WHERE (fold(p.name) LIKE ? ESCAPE '\\' OR fold(p.ref) LIKE ? ESCAPE '\\' OR p.ean LIKE ? ESCAPE '\\' OR fold(p.brand) LIKE ? ESCAPE '\\') ${req.query.low ? 'AND p.active=1 AND p.qty_on_hand<=p.qty_min AND p.qty_min>0 AND p.is_service=0' : ''}
      ORDER BY p.name LIMIT 1000`, q, q, q, q);
  },
  detail: (id) => {
    const p = get('SELECT * FROM products WHERE id=?', id);
    if (p) p.moves = all('SELECT m.*, d.number AS doc_number, pu.number AS purchase_number FROM stock_moves m LEFT JOIN documents d ON d.id=m.document_id LEFT JOIN purchases pu ON pu.id=m.purchase_id WHERE m.product_id=? ORDER BY m.id DESC LIMIT 200', id);
    return p;
  },
});
api.post('/products/:id/adjust', wrap((req) => {
  const p = get('SELECT * FROM products WHERE id=?', req.params.id);
  if (!p) throw new BusinessError('Article introuvable', 404);
  // Champ laissé vide = pas de quantité comptée (et surtout pas « zéro »)
  if (blank(req.body.qty) || typeof req.body.qty === 'boolean') throw new BusinessError('Indiquez la quantité comptée');
  const target = typeof req.body.qty === 'string' ? Number(req.body.qty.replace(',', '.')) : Number(req.body.qty);
  if (!Number.isFinite(target)) throw new BusinessError('Quantité invalide');
  const diff = round2(target - p.qty_on_hand);
  if (diff) addStockMove({ product_id: p.id, qty: diff, kind: 'adjust', unit_cost: p.purchase_price, note: req.body.note || 'Inventaire', user_id: req.user.id });
  return { ok: true, diff };
}));
api.get('/stock/moves', (req, res) => res.json(all(`SELECT m.*, p.ref, p.name, d.number AS doc_number, pu.number AS purchase_number, u.name AS user_name FROM stock_moves m
  JOIN products p ON p.id=m.product_id LEFT JOIN documents d ON d.id=m.document_id LEFT JOIN purchases pu ON pu.id=m.purchase_id LEFT JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 500`)));
api.get('/stock/valuation', (req, res) => res.json(get('SELECT ROUND(SUM(qty_on_hand*purchase_price),2) AS purchase_value, ROUND(SUM(qty_on_hand*sale_price),2) AS sale_value, COUNT(*) AS items FROM products WHERE active=1 AND is_service=0 AND qty_on_hand>0')));
// Proposition de réapprovisionnement groupée par fournisseur
api.post('/stock/reorder', wrap(() => {
  // Les articles déjà en commande (brouillon ou commandé, pas encore reçus) ne sont pas recommandés une deuxième fois
  const low = all(`SELECT * FROM products p WHERE active=1 AND is_service=0 AND qty_min>0 AND qty_on_hand<=qty_min AND supplier_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM purchase_lines l WHERE l.product_id=p.id AND COALESCE(l.received_qty,0) < l.quantity)`);
  const bySupplier = {};
  for (const p of low) (bySupplier[p.supplier_id] ||= []).push(p);
  const created = [];
  for (const [sid, items] of Object.entries(bySupplier)) {
    created.push(savePurchase({
      supplier_id: Number(sid), notes: 'Réapprovisionnement automatique',
      lines: items.map((p) => ({ product_id: p.id, description: `${p.ref || ''} ${p.name}`.trim(), quantity: Math.max(1, p.qty_min * 2 - p.qty_on_hand), unit_price: p.purchase_price, tax_rate: p.tax_rate })),
    }));
  }
  const lowCount = (extra) => get(`SELECT COUNT(*) n FROM products WHERE active=1 AND is_service=0 AND qty_min>0 AND qty_on_hand<=qty_min AND ${extra}`).n;
  return { created, already_ordered: lowCount('supplier_id IS NOT NULL') - low.length, no_supplier: lowCount('supplier_id IS NULL') };
}));

crud('appointments', 'appointments', ['customer_id', 'vehicle_id', 'mechanic_id', 'start', 'end', 'title', 'notes', 'status', 'document_id', 'courtesy_car'], {
  model: 'appointment',
  spec: { required: ['start', 'end'], datetimes: ['start', 'end'], refs: { customer_id: 'customers', vehicle_id: 'vehicles', mechanic_id: 'users', document_id: 'documents' } },
  check: (d, cur) => { const st = d.start ?? cur?.start, en = d.end ?? cur?.end; if (st && en && en <= st) throw new BusinessError('La fin du rendez-vous doit être après le début'); },
  list: (req) => all(`SELECT a.*, c.name AS customer_name, c.phone AS customer_phone, v.plate, v.make, v.model, u.name AS mechanic_name, u.color AS mechanic_color, d.number AS document_number
    FROM appointments a LEFT JOIN customers c ON c.id=a.customer_id LEFT JOIN vehicles v ON v.id=a.vehicle_id LEFT JOIN users u ON u.id=a.mechanic_id LEFT JOIN documents d ON d.id=a.document_id
    WHERE substr(a.start,1,10) BETWEEN ? AND ? ORDER BY a.start`, req.query.from || '0000', req.query.to || '9999'),
});
// Arrivée du véhicule : création de l'OR depuis le rendez-vous
api.post('/appointments/:id/order', wrap((req) => {
  const a = get('SELECT * FROM appointments WHERE id=?', req.params.id);
  if (!a) throw new BusinessError('Rendez-vous introuvable', 404);
  if (a.document_id) return { id: a.document_id };
  const id = saveDocument({ type: 'order', customer_id: a.customer_id, vehicle_id: a.vehicle_id, mechanic_id: a.mechanic_id, customer_complaint: [a.title, a.notes].filter(Boolean).join(' — '), promised_at: a.end, lines: [] });
  run("UPDATE appointments SET document_id=?, status='arrived' WHERE id=?", id, a.id);
  return { id };
}));

// ---------- Documents ----------
api.get('/documents', (req, res) => {
  const where = ['1=1'];
  const p = [];
  const types = queryList(req.query.type), statuses = queryList(req.query.status);
  if (types.length) { where.push('d.type IN (' + types.map(() => '?').join(',') + ')'); p.push(...types); }
  if (statuses.length) { where.push('d.status IN (' + statuses.map(() => '?').join(',') + ')'); p.push(...statuses); }
  // Sans le droit Atelier on ne voit pas les OR ; sans le droit Ventes on ne voit que les OR
  if (!can(req.user, 'atelier')) where.push("d.type!='order'");
  if (!can(req.user, 'ventes')) where.push("d.type='order'");
  if (req.query.customer_id) { where.push('d.customer_id=?'); p.push(req.query.customer_id); }
  if (req.query.overdue) { where.push("d.status IN ('posted','partial') AND d.due_date<?"); p.push(today()); }
  if (req.query.q) { const q = `%${req.query.q}%`; where.push('(d.number LIKE ? OR c.name LIKE ? OR v.plate LIKE ?)'); p.push(q, q, q); }
  res.json(all(`SELECT d.id, d.type, d.number, d.status, d.date, d.due_date, d.subtotal, d.total, d.amount_paid, d.promised_at, d.customer_complaint,
      d.mechanic_id, d.stage, c.name AS customer_name, v.plate, v.make, v.model, u.name AS mechanic_name, u.color AS mechanic_color,
      (SELECT ROUND(SUM(quantity),2) FROM document_lines WHERE document_id=d.id AND kind='labor') AS hours_sold,
      CASE WHEN d.type='order' THEN (SELECT ROUND(SUM(CASE WHEN kind NOT IN ('labor','fee') THEN 0 WHEN planned_hours IS NOT NULL THEN planned_hours WHEN kind='labor' THEN MAX(quantity, 0) ELSE 0 END),2)
        FROM document_lines WHERE document_id=d.id) END AS hours_planned,
      CASE WHEN d.type='order' THEN (SELECT ROUND(SUM(MAX(0, (julianday(COALESCE(end, ?)) - julianday(start)) * 24)), 4) FROM time_entries WHERE document_id=d.id AND kind='work') END AS hours_spent,
      CASE WHEN d.type='order' THEN (SELECT ROUND(SUM(MAX(0, (julianday(COALESCE(t.end, ?)) - julianday(t.start)) * 24)), 4) FROM time_entries t JOIN document_lines l ON l.id=t.line_id AND l.document_id=t.document_id
        WHERE t.document_id=d.id AND t.kind='work' AND l.kind IN ('labor','fee')
          AND (CASE WHEN l.planned_hours IS NOT NULL THEN l.planned_hours WHEN l.kind='labor' THEN MAX(l.quantity, 0) ELSE 0 END) <= 0) END AS hours_unplanned,
      (SELECT COUNT(*) FROM time_entries WHERE document_id=d.id AND end IS NULL AND kind='work') AS active_workers
    FROM documents d LEFT JOIN customers c ON c.id=d.customer_id LEFT JOIN vehicles v ON v.id=d.vehicle_id LEFT JOIN users u ON u.id=d.mechanic_id
    WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT 1000`, localDateTime(), localDateTime(), ...p));
});
api.get('/documents/:id', wrap((req) => getDocument(Number(req.params.id))));
api.post('/documents', wrap((req) => ({ id: saveDocument(req.body) })));
api.put('/documents/:id', wrap((req) => ({ id: saveDocument(req.body, Number(req.params.id)) })));
api.delete('/documents/:id', wrap((req) => {
  const d = get('SELECT * FROM documents WHERE id=?', req.params.id);
  if (!d) throw new BusinessError('Introuvable', 404);
  if ((d.type === 'invoice' || d.type === 'credit_note') && d.status !== 'draft') throw new BusinessError('Une facture validée ne peut pas être supprimée : créez une note de crédit.');
  if (get("SELECT 1 FROM payments WHERE document_id=?", d.id)) throw new BusinessError('Ce document a des paiements enregistrés : il ne peut pas être supprimé.');
  tx(() => {
    run('UPDATE documents SET parent_id=NULL WHERE parent_id=?', d.id);
    run('UPDATE appointments SET document_id=NULL WHERE document_id=?', d.id);
    run("UPDATE time_entries SET line_id=NULL, end=COALESCE(end, ?) WHERE document_id=?", localDateTime(), d.id);
    run('DELETE FROM order_links WHERE document_id=?', d.id);
    run('DELETE FROM order_posts WHERE document_id=?', d.id);
    run('DELETE FROM documents WHERE id=?', d.id);
    forgetRecord('document', d.id);
    // La facture brouillon d'un OR est supprimée : l'OR redevient « Terminé » et peut de nouveau être facturé
    const parent = d.parent_id && d.type === 'invoice' ? get('SELECT * FROM documents WHERE id=?', d.parent_id) : null;
    if (parent?.type === 'order' && parent.status === 'invoiced' && !get("SELECT 1 FROM documents WHERE parent_id=? AND type='invoice'", parent.id)) {
      run("UPDATE documents SET status='done' WHERE id=?", parent.id);
      stageFromStatus(parent.id, 'done');
    }
  });
  return { ok: true };
}));
api.post('/documents/:id/status', wrap((req) => {
  const allowed = { quote: ['draft', 'sent', 'accepted', 'refused'], order: ['open', 'in_progress', 'waiting_parts', 'done', 'cancelled'] };
  const d = get('SELECT * FROM documents WHERE id=?', req.params.id);
  if (!allowed[d?.type]?.includes(req.body.status)) throw new BusinessError('Statut invalide');
  if (d.status === 'invoiced') throw new BusinessError('OR déjà facturé');
  run('UPDATE documents SET status=? WHERE id=?', req.body.status, d.id);
  if (d.type === 'order') {
    // OR terminé ou annulé par le bureau : les chronos encore en cours dessus s'arrêtent (comme à la tablette)
    if (['done', 'cancelled'].includes(req.body.status)) stopOrderTimers(d.id);
    stageFromStatus(d.id, req.body.status);
  }
  return { ok: true };
}));
// Chrono lancé depuis la fiche de l'OR, pour le mécanicien choisi (même règle qu'à la tablette : un seul travail à la fois).
// Pour soi-même : le droit « Utilisateur » sur Atelier suffit ; pour quelqu'un d'autre : administrateur des Présences.
api.post('/documents/:id/clock', wrap((req) => {
  const id = Number(req.params.id);
  const d = get('SELECT id, type FROM documents WHERE id=?', id);
  if (!d) throw new BusinessError('Introuvable', 404);
  if (d.type !== 'order') throw new BusinessError('Le chrono se lance sur un ordre de réparation');
  const target = get('SELECT id, name, role, active, permissions FROM users WHERE id=?', Number(req.body.user_id) || 0);
  if (!target || !target.active) throw new BusinessError('Choisissez le mécanicien pour qui lancer le chrono');
  if (target.id !== req.user.id && !can(req.user, 'presences', 'manager')) throw new BusinessError('Lancer ou arrêter le chrono de quelqu\'un d\'autre est réservé aux administrateurs des Présences', 403);
  if (target.role !== 'mechanic' && !can(target, 'atelier', 'user')) throw new BusinessError(`${target.name} n'a pas le droit de travailler sur un OR`);
  let switched = null;
  if (req.body.action === 'start') ({ switched } = startWork(target.id, id, req.body.line_id));
  else if (req.body.action === 'stop') run("UPDATE time_entries SET end=? WHERE user_id=? AND document_id=? AND kind='work' AND end IS NULL", localDateTime(), target.id, id);
  else throw new BusinessError('Action inconnue');
  return { ok: true, switched };
}));
api.post('/documents/:id/convert', wrap((req) => {
  const id = convertDocument(Number(req.params.id), req.body.type);
  const n = get('SELECT type, number FROM documents WHERE id=?', id);
  logMessage('document', Number(req.params.id), `➡️ ${{ order: 'Ordre de réparation', invoice: 'Facture', credit_note: 'Note de crédit' }[n.type]} créé(e) ${n.number || ''}`, req.user.id, 'system');
  logMessage('document', id, `Créé(e) à partir de ${get('SELECT number FROM documents WHERE id=?', req.params.id).number || 'un brouillon'}`, req.user.id, 'system');
  return { id };
}));
api.post('/documents/:id/post', wrap((req) => {
  const number = postInvoice(Number(req.params.id));
  logMessage('document', Number(req.params.id), `✔ Validée sous le numéro ${number}`, req.user.id, 'system');
  return { number };
}));
api.post('/documents/:id/payments', wrap((req) => {
  const id = registerPayment({ ...req.body, document_id: Number(req.params.id) });
  logMessage('document', Number(req.params.id), `💶 Paiement enregistré : ${Number(req.body.amount).toFixed(2)} €`, req.user.id, 'system');
  return { id };
}));
// QR code de paiement SEPA (EPC) imprimé sur la facture — scannable par les applis bancaires
api.get('/documents/:id/qr.svg', wrap(async (req, res) => {
  const d = getDocument(Number(req.params.id));
  const c = getSettings().company;
  const residual = round2(d.total - d.amount_paid);
  if (!c.iban || residual <= 0) return res.status(204).end();
  const payload = ['BCD', '002', '1', 'SCT', c.bic || '', (c.name || '').slice(0, 70), c.iban.replace(/\s/g, ''), `EUR${residual.toFixed(2)}`, '', '', d.number || '', ''].join('\n');
  res.type('image/svg+xml').send(await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }));
}));

// ---------- Achats ----------
api.get('/purchases', (req, res) => res.json(all(`SELECT p.*, s.name AS supplier_name, (SELECT COUNT(*) FROM attachments a WHERE a.model='purchase' AND a.record_id=p.id) AS attachment_count
  FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id ${req.query.review ? "WHERE p.review='to_review' AND p.posted=0" : ''} ORDER BY p.id DESC LIMIT 1000`)));
api.get('/purchases/:id', wrap((req) => getPurchase(Number(req.params.id))));
api.post('/purchases', wrap((req) => ({ id: savePurchase(req.body) })));
api.put('/purchases/:id', wrap((req) => ({ id: savePurchase(req.body, Number(req.params.id)) })));
api.delete('/purchases/:id', wrap((req) => {
  const p = get('SELECT * FROM purchases WHERE id=?', req.params.id);
  if (p?.posted) throw new BusinessError('Achat comptabilisé : suppression impossible');
  if (get('SELECT 1 FROM purchase_lines WHERE purchase_id=? AND received_qty>0', req.params.id)) throw new BusinessError('Marchandise déjà réceptionnée');
  tx(() => { run('DELETE FROM purchases WHERE id=?', req.params.id); forgetRecord('purchase', Number(req.params.id)); });
  return { ok: true };
}));
// Option « validation des achats » : au-delà du seuil, un achat encore en brouillon doit passer par un administrateur des achats
function assertApproved(req) {
  const o = options().achats;
  const p = get('SELECT total, status FROM purchases WHERE id=?', req.params.id);
  if (o.approval && p && p.status === 'draft' && p.total >= o.approval_amount && !can(req.user, 'achats', 'manager')) {
    throw new BusinessError(`Achat de ${p.total.toFixed(2)} € : au-delà de ${o.approval_amount} €, il doit être validé par un administrateur des achats.`, 403);
  }
}
api.post('/purchases/:id/order', wrap((req) => {
  assertApproved(req);
  run("UPDATE purchases SET status='ordered' WHERE id=? AND status='draft'", req.params.id);
  return { ok: true };
}));
api.post('/purchases/:id/receive', wrap((req) => { assertApproved(req); receivePurchase(Number(req.params.id)); return { ok: true }; }));
api.post('/purchases/:id/post', wrap((req) => { assertApproved(req); postPurchase(Number(req.params.id)); run("UPDATE purchases SET review='ok' WHERE id=?", req.params.id); return { ok: true }; }));
api.post('/purchases/:id/reviewed', wrap((req) => { run("UPDATE purchases SET review='ok' WHERE id=?", req.params.id); return { ok: true }; }));
api.post('/purchases/:id/reanalyze', wrap((req) => reanalyze(Number(req.params.id))));

// ---------- Factures fournisseurs : dépôt de fichier, boîte e-mail, pièces jointes ----------
const rawBody = express.raw({ type: () => true, limit: '40mb' });
const fileName = (req) => { try { return decodeURIComponent(req.headers['x-filename'] || 'document').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200) || 'document'; } catch { return 'document'; } };
const fileMeta = (req) => ({ buffer: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), mime: (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), filename: fileName(req) });
// Seuls ces formats s'affichent dans le navigateur ; tout le reste (HTML, SVG…) est téléchargé, jamais exécuté dans le logiciel
const INLINE_MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);
api.post('/bills/upload', rawBody, wrap((req) => createBillFromFile({ ...fileMeta(req), source: 'upload' })));
api.get('/bills/inbox', (req, res) => res.json(publicInboxConfig()));
api.put('/bills/inbox', adminOnly, wrap((req) => { saveInboxConfig(req.body); return publicInboxConfig(); }));
api.post('/bills/inbox/test', adminOnly, wrap(() => testInbox()));
api.post('/bills/inbox/check', wrap(() => checkInbox()));
api.get('/attachments/:model/:id', (req, res) => res.json(listAttachments(req.params.model, Number(req.params.id))));
api.post('/attachments/:model/:id', rawBody, wrap((req) => {
  if (!['purchase', 'document', 'customer', 'vehicle', 'supplier', 'product'].includes(req.params.model)) throw new BusinessError('Type de fiche inconnu');
  if (!req.body?.length) throw new BusinessError('Fichier vide');
  return { id: saveAttachment(req.params.model, Number(req.params.id), { ...fileMeta(req), source: 'manual' }) };
}));
api.get('/attachment/:id', (req, res) => {
  const a = attachmentFile(Number(req.params.id));
  if (!a) return res.status(404).end();
  const safe = INLINE_MIMES.has(a.mime);
  res.type(safe ? a.mime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${req.query.download || !safe ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.sendFile(a.full);
});
api.delete('/attachment/:id', wrap((req) => { deleteAttachment(Number(req.params.id)); return { ok: true }; }));
api.post('/purchases/:id/payments', wrap((req) => ({ id: registerPayment({ ...req.body, purchase_id: Number(req.params.id) }) })));

// ---------- Comptabilité ----------
const period = (req) => [req.query.from || `${today().slice(0, 4)}-01-01`, req.query.to || today()];
api.get('/accounting/accounts', (req, res) => res.json(all('SELECT * FROM accounts ORDER BY code')));
api.post('/accounting/accounts', adminOnly, wrap((req) => {
  const { code, name, type } = req.body;
  if (!code || !name || !['asset', 'liability', 'equity', 'income', 'expense'].includes(type)) throw new BusinessError('Compte invalide');
  run('INSERT INTO accounts(code,name,type) VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name, type=excluded.type', code, name, type);
  return { ok: true };
}));
api.get('/accounting/journals', (req, res) => res.json(all('SELECT * FROM journals')));
api.get('/accounting/moves', (req, res) => {
  const [from, to] = period(req);
  const moves = all(`SELECT * FROM moves WHERE date BETWEEN ? AND ? ${req.query.journal ? 'AND journal_code=?' : ''} ORDER BY date DESC, id DESC LIMIT 1000`, from, to, ...(req.query.journal ? [req.query.journal] : []));
  const lines = moves.length ? all(`SELECT l.*, a.name AS account_name FROM move_lines l JOIN accounts a ON a.code=l.account_code WHERE move_id IN (${moves.map(() => '?').join(',')})`, ...moves.map((m) => m.id)) : [];
  for (const m of moves) m.lines = lines.filter((l) => l.move_id === m.id);
  res.json(moves);
});
api.post('/accounting/moves', wrap((req) => {
  const { date, label, journal_code = 'OD' } = req.body;
  // Écriture manuelle : au moins deux lignes, des montants positifs, des comptes et un journal qui existent
  const lines = (Array.isArray(req.body.lines) ? req.body.lines : []).map((l) => ({ account_code: String(l?.account_code || ''), label: l?.label || label, debit: round2(l?.debit), credit: round2(l?.credit) }))
    .filter((l) => l.debit || l.credit);
  if (!String(label || '').trim()) throw new BusinessError('Libellé de l\'écriture requis');
  if (lines.length < 2) throw new BusinessError('Une écriture comporte au moins deux lignes avec un montant');
  if (lines.some((l) => l.debit < 0 || l.credit < 0)) throw new BusinessError('Les montants doivent être positifs (utilisez la colonne débit ou crédit)');
  if (lines.some((l) => l.debit && l.credit)) throw new BusinessError('Une ligne est soit au débit, soit au crédit');
  const unknown = lines.find((l) => !get('SELECT 1 FROM accounts WHERE code=?', l.account_code));
  if (unknown) throw new BusinessError(`Compte inconnu : ${unknown.account_code || '(vide)'}`);
  if (!get('SELECT 1 FROM journals WHERE code=?', journal_code)) throw new BusinessError('Journal inconnu');
  return { id: tx(() => createMove({ journal_code, date: date || today(), ref: 'OD', label }, lines)) };
}));
api.get('/accounting/ledger/:code', (req, res) => {
  const [from, to] = period(req);
  const opening = get('SELECT ROUND(COALESCE(SUM(l.debit-l.credit),0),2) v FROM move_lines l JOIN moves m ON m.id=l.move_id WHERE l.account_code=? AND m.date<?', req.params.code, from).v;
  const lines = all(`SELECT l.*, m.date, m.ref, m.journal_code, m.label AS move_label FROM move_lines l JOIN moves m ON m.id=l.move_id
    WHERE l.account_code=? AND m.date BETWEEN ? AND ? ORDER BY m.date, m.id`, req.params.code, from, to);
  let bal = opening;
  for (const l of lines) { bal = round2(bal + l.debit - l.credit); l.balance = bal; }
  res.json({ account: get('SELECT * FROM accounts WHERE code=?', req.params.code), opening, lines });
});
api.get('/accounting/balance', (req, res) => res.json(trialBalance(...period(req))));
api.get('/accounting/vat', (req, res) => res.json(vatReport(...period(req))));
api.get('/accounting/pnl', (req, res) => res.json(profitAndLoss(...period(req))));
api.get('/accounting/aged', (req, res) => {
  const t = today();
  res.json(all(`SELECT d.id, d.number, d.date, d.due_date, d.total, d.amount_paid, ROUND(d.total-d.amount_paid,2) AS residual, c.id AS customer_id, c.name AS customer_name, c.email, c.phone,
    CAST(julianday(?) - julianday(d.due_date) AS INTEGER) AS days_late
    FROM documents d JOIN customers c ON c.id=d.customer_id WHERE d.type='invoice' AND d.status IN ('posted','partial') ORDER BY d.due_date`, t));
});
// Export FEC-like (CSV) pour la fiduciaire
api.get('/accounting/export.csv', (req, res) => {
  const [from, to] = period(req);
  const rows = all(`SELECT m.journal_code, m.id AS move_id, m.date, m.ref, l.account_code, a.name AS account_name, l.partner_type, l.partner_id, l.label, l.debit, l.credit
    FROM move_lines l JOIN moves m ON m.id=l.move_id JOIN accounts a ON a.code=l.account_code WHERE m.date BETWEEN ? AND ? ORDER BY m.date, m.id`, from, to);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['Journal;Piece;Date;Reference;Compte;LibelleCompte;TypeTiers;IdTiers;Libelle;Debit;Credit',
    ...rows.map((r) => [r.journal_code, r.move_id, r.date, r.ref, r.account_code, r.account_name, r.partner_type, r.partner_id, r.label, String(r.debit).replace('.', ','), String(r.credit).replace('.', ',')].map(esc).join(';'))].join('\r\n');
  res.type('text/csv').attachment(`ecritures_${from}_${to}.csv`).send('﻿' + csv);
});

// ---------- Banque ----------
crud('bank-accounts', 'bank_accounts', ['name', 'iban', 'bic', 'bank_name', 'account_code', 'opening_balance', 'provider', 'provider_config'], {
  spec: { required: ['name'], numbers: ['opening_balance'] },
  // solde d'ouverture laissé vide = 0 (sinon le solde du compte s'affichait toujours à 0,00 €)
  beforeSave: (d) => ('opening_balance' in d && d.opening_balance === null ? { ...d, opening_balance: 0 } : d),
  check: (d) => { if (d.account_code && !get('SELECT 1 FROM accounts WHERE code=?', d.account_code)) throw new BusinessError('Compte comptable inconnu'); },
  list: () => all(`SELECT b.*, (SELECT COUNT(*) FROM bank_lines WHERE bank_account_id=b.id AND status='unmatched') AS unmatched,
    ROUND(COALESCE(b.opening_balance,0) + COALESCE((SELECT SUM(amount) FROM bank_lines WHERE bank_account_id=b.id),0),2) AS statement_balance FROM bank_accounts b ORDER BY b.id`),
});
api.get('/bank/providers', (req, res) => res.json(PROVIDERS));
api.get('/bank/lines', (req, res) => {
  const lines = all(`SELECT l.*, b.name AS account_name FROM bank_lines l JOIN bank_accounts b ON b.id=l.bank_account_id
    WHERE (? IS NULL OR l.bank_account_id=?) AND (? IS NULL OR l.status=?) ORDER BY l.date DESC, l.id DESC LIMIT 500`,
  req.query.account || null, req.query.account || null, req.query.status || null, req.query.status || null);
  for (const l of lines) if (l.status === 'unmatched') { l.suggestions = suggestions(l); l.remaining = remainingOf(l) * (l.amount < 0 ? -1 : 1); }
  res.json(lines);
});
api.post('/bank/import/:accountId', wrap((req) => {
  const text = typeof req.body === 'string' ? req.body : req.body.content;
  if (!text) throw new BusinessError('Fichier vide');
  const lines = /<\?xml|<Document/i.test(text) ? parseCamt(text) : parseCsv(text);
  if (!lines.length) throw new BusinessError(lines.rejected ? `Aucune opération reconnue : ${lines.rejected} ligne(s) dont la date ou le montant est illisible. Formats acceptés : CAMT.053 XML, CSV.` : 'Aucune opération reconnue dans ce fichier (formats acceptés : CAMT.053 XML, CSV).');
  return importLines(Number(req.params.accountId), lines);
}));
api.post('/bank/sync/:accountId', wrap((req) => syncAccount(Number(req.params.accountId))));
api.post('/bank/lines/:id/match', wrap((req) => ({ payment_id: matchLine(Number(req.params.id), req.body) })));
api.post('/bank/lines/:id/assign', wrap((req) => ({ move_id: assignLine(Number(req.params.id), req.body.account_code, req.body.label) })));
api.post('/bank/lines/:id/ignore', wrap((req) => { run("UPDATE bank_lines SET status='ignored' WHERE id=? AND status='unmatched'", req.params.id); return { ok: true }; }));
// Annuler : une opération ignorée, rapprochée ou affectée par erreur redevient « à rapprocher »
api.post('/bank/lines/:id/unmatch', needManager('banque'), wrap((req) => unmatchLine(Number(req.params.id))));
api.post('/bank/auto-reconcile', wrap(() => autoReconcile()));
// Annuler un paiement saisi par erreur (réservé aux administrateurs de la banque)
api.delete('/payments/:id', wrap((req) => {
  const p = get('SELECT * FROM payments WHERE id=?', req.params.id);
  const r = cancelPayment(Number(req.params.id));
  if (p?.document_id) logMessage('document', p.document_id, `↩️ Paiement de ${Number(p.amount).toFixed(2)} € annulé`, req.user.id, 'system');
  if (p?.purchase_id) logMessage('purchase', p.purchase_id, `↩️ Paiement de ${Number(p.amount).toFixed(2)} € annulé`, req.user.id, 'system');
  return r;
}));
api.get('/payments', (req, res) => res.json(all(`SELECT p.*, d.number AS document_number, pu.number AS purchase_number, c.name AS customer_name, s.name AS supplier_name
  FROM payments p LEFT JOIN documents d ON d.id=p.document_id LEFT JOIN purchases pu ON pu.id=p.purchase_id LEFT JOIN customers c ON c.id=p.customer_id LEFT JOIN suppliers s ON s.id=p.supplier_id
  ORDER BY p.date DESC, p.id DESC LIMIT 500`)));

// ---------- Pointage (vue bureau) ----------
api.get('/timesheets', (req, res) => {
  const { from, to } = datePeriod(req.query.from || today(), req.query.to || today());
  const entries = all(`SELECT t.*, u.name AS user_name, u.color, d.number AS document_number, v.plate, l.description AS line_description FROM time_entries t JOIN users u ON u.id=t.user_id
    LEFT JOIN documents d ON d.id=t.document_id LEFT JOIN vehicles v ON v.id=d.vehicle_id LEFT JOIN document_lines l ON l.id=t.line_id AND l.document_id=t.document_id
    WHERE substr(t.start,1,10) BETWEEN ? AND ? ORDER BY t.start`, from, to);
  for (const e of entries) e.hours = round2(durationHours(e));
  const seen = new Set(entries.map((e) => e.user_id));
  const users = all("SELECT id, name, color, hourly_cost, active AS enabled FROM users WHERE role='mechanic' ORDER BY name").filter((u) => u.enabled || seen.has(u.id)).map((u) => {
    const mine = entries.filter((e) => e.user_id === u.id);
    const presence = round2(mine.filter((e) => e.kind === 'presence').reduce((s, e) => s + e.hours, 0));
    const work = round2(mine.filter((e) => e.kind === 'work').reduce((s, e) => s + e.hours, 0));
    return { ...u, presence, work, productivity: presence ? Math.round((work / presence) * 100) : null, active: mine.some((e) => !e.end) };
  });
  res.json({ entries, users });
});
// Statistiques par mécanicien : heures sur OR, temps prévu / temps passé, dépassements (tableau de bord et feuilles de temps)
api.get('/timesheets/stats', (req, res) => {
  const { from, to } = datePeriod(req.query.from || today(), req.query.to || today());
  res.json(workStats(from, to));
});
// Corriger ou supprimer un pointage : réservé aux administrateurs des présences (comme /attendance)
api.put('/timesheets/:id', needManager('presences'), wrap((req) => {
  const cur = get('SELECT * FROM time_entries WHERE id=?', req.params.id);
  if (!cur) throw new BusinessError('Pointage introuvable', 404);
  const b = req.body || {};
  const start = b.start ?? cur.start, end = b.end === undefined ? cur.end : b.end || null;
  if (!validDateTime(start)) throw new BusinessError('Heure de début invalide');
  if (end && !validDateTime(end)) throw new BusinessError('Heure de fin invalide');
  if (end && end <= start) throw new BusinessError('La fin doit être après le début');
  // un pointage ne peut pas commencer dans le futur (les heures seraient comptées avant d'être faites)
  const limit = localDateTime(new Date(Date.now() + 60000)).slice(0, 16);
  if (start.slice(0, 16) > limit || (end && end.slice(0, 16) > limit)) throw new BusinessError('Un pointage ne peut pas être dans le futur');
  // une personne n'a qu'un seul chrono de travail ouvert à la fois
  if (cur.kind === 'work' && !end && get("SELECT 1 FROM time_entries WHERE user_id=? AND kind='work' AND end IS NULL AND id!=?", cur.user_id, cur.id)) {
    throw new BusinessError('Cette personne a déjà un chrono en cours : indiquez une heure de fin.');
  }
  // pointage déplacé sur un autre OR : il n'est plus rattaché à une intervention de l'ancien
  const moved = b.document_id !== undefined && (b.document_id || null) !== (cur.document_id || null);
  // chrono arrêté automatiquement, dont le gérant corrige les heures : il redevient un pointage normal (plus « à vérifier »)
  const fixed = cur.source === 'auto' && (start !== cur.start || end !== cur.end);
  update('time_entries', cur.id, { ...b, start, end, line_id: moved ? null : undefined, source: fixed ? 'manual' : undefined }, ['start', 'end', 'note', 'document_id', 'line_id', 'source']);
  return { ok: true };
}));
api.delete('/timesheets/:id', needManager('presences'), wrap((req) => { run('DELETE FROM time_entries WHERE id=?', req.params.id); return { ok: true }; }));

// ---------- Utilisateurs & paramètres ----------
// ---------- Utilisateurs et droits d'accès ----------
const USER_COLS = ['name', 'email', 'role', 'color', 'hourly_cost', 'active', 'password_hash', 'pin_hash', 'permissions', 'job_title', 'badge'];
api.get('/users', (req, res) => {
  const admin = req.user.role === 'admin';
  if (!admin) {
    // Le coût horaire n'est visible qu'avec un droit sur les présences (administrateur) ou la comptabilité
    const cost = can(req.user, 'presences', 'manager') || can(req.user, 'comptabilite', 'read');
    return res.json(all(`SELECT id, name, role, color, active, job_title${cost ? ', hourly_cost' : ''} FROM users ORDER BY active DESC, role, name`));
  }
  res.json(all(`SELECT id, name, email, role, color, hourly_cost, active, job_title, last_login, pin_hash IS NOT NULL AS has_pin,
      permissions, badge, invite_hash IS NOT NULL AND invite_expires > strftime('%Y-%m-%dT%H:%M:%fZ','now') AS invited, password_hash IS NOT NULL AS has_password
    FROM users ORDER BY active DESC, role, name`).map((u) => ({ ...u, permissions: normalizePerms(u.permissions ?? PRESETS.bureau.perms) })));
});
api.get('/access/meta', adminOnly, (req, res) => res.json({ apps: APPS, levels: LEVELS, labels: LEVEL_LABELS, presets: PRESETS }));
function userData(b, creating, cur = null) {
  const data = { ...b };
  if ('active' in b) data.active = b.active === true || b.active === 1 || b.active === '1' ? 1 : 0;
  if (b.name !== undefined) data.name = String(b.name ?? '').trim();
  if (b.email !== undefined) data.email = b.email ? String(b.email).trim().toLowerCase() : null;
  if (b.role !== undefined && !['admin', 'office', 'mechanic'].includes(b.role)) throw new BusinessError('Type d\'utilisateur inconnu');
  if (b.password) { if (String(b.password).length < 8) throw new BusinessError('Mot de passe : 8 caractères minimum'); data.password_hash = hashSecret(b.password); }
  if (b.pin) { if (!/^\d{4,6}$/.test(String(b.pin))) throw new BusinessError('Code PIN : 4 à 6 chiffres'); data.pin_hash = hashSecret(String(b.pin)); }
  if (b.hourly_cost !== undefined && b.hourly_cost !== null && b.hourly_cost !== '' && !Number.isFinite(Number(b.hourly_cost))) throw new BusinessError('Coût horaire invalide');
  if (b.permissions !== undefined) data.permissions = JSON.stringify(normalizePerms(b.permissions));
  if (b.badge !== undefined) {
    data.badge = String(b.badge || '').trim() || null;
    if (data.badge && get('SELECT id FROM users WHERE badge=? AND id!=?', data.badge, b.id || 0)) throw new BusinessError('Ce badge est déjà attribué');
  }
  if (data.email && get('SELECT id FROM users WHERE email=? AND id!=?', data.email, b.id || 0)) throw new BusinessError('Cette adresse e-mail est déjà utilisée par un autre utilisateur');
  // Mêmes contrôles à la création et à la modification, sur la fiche telle qu'elle sera enregistrée
  const role = data.role ?? cur?.role ?? 'office';
  if (!(data.name ?? cur?.name)) throw new BusinessError('Nom requis');
  if (role !== 'mechanic' && !(data.email !== undefined ? data.email : cur?.email)) throw new BusinessError('E-mail requis pour un accès au logiciel');
  if (role === 'mechanic' && !data.pin_hash && !cur?.pin_hash) throw new BusinessError('Code PIN de 4 à 6 chiffres requis pour le kiosque');
  delete data.password; delete data.pin;
  return data;
}
// Adresse à mettre dans les liens envoyés (invitation, site…) : l'adresse publique si elle est configurée ;
// sinon l'adresse utilisée — mais jamais « localhost », qui ne s'ouvre que sur le PC du garage : on prend son adresse réseau
const baseUrl = (req) => {
  const pub = getSettings().public_url;
  if (pub) return pub.replace(/\/$/, '');
  const host = req.get('host') || '';
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) { const lan = lanUrls(process.env.PORT || 3000)[0]; if (lan) return lan.replace(/\/$/, ''); }
  return `${req.protocol}://${host}`;
};
async function inviteUser(req, id, send) {
  const u = get('SELECT * FROM users WHERE id=?', id);
  if (!u?.email) throw new BusinessError('Adresse e-mail requise pour inviter');
  // On vérifie AVANT de créer un nouveau lien : un envoi impossible ne doit pas rendre l'ancien lien inutilisable
  if (send && !isMailConfigured()) throw new BusinessError('L\'envoi d\'e-mails n\'est pas configuré (Paramètres → E-mails). Créez le lien sans l\'envoyer, puis transmettez-le vous-même.');
  const { token, expires } = createInvite(id);
  const url = `${baseUrl(req)}/#/invite/${token}`;
  let sent = false;
  if (send) {
    const c = getSettings().company;
    try {
      await sendEmail({ model: 'user', record_id: id, to: u.email, subject: `Invitation : accès au logiciel de ${c.name}`,
        intro: `Bonjour ${u.name},\n\n${req.user.name} vous donne accès au logiciel de gestion de ${c.name}.\n\nCliquez sur ce lien pour choisir votre mot de passe (valable 7 jours) :\n${url}\n\nÀ bientôt !`, include_document: false, user_id: req.user.id });
      sent = true;
    } finally {
      // Le lien d'invitation est un secret : il ne reste pas lisible dans la boîte d'envoi (envoi réussi ou non)
      hideInviteLinks();
    }
  }
  return { url, expires, sent };
}
const hideInviteLinks = () => run("UPDATE emails SET intro='(invitation : le lien personnel n''est pas conservé)' WHERE model='user' AND intro LIKE '%/invite/%'");
hideInviteLinks(); // anciennes invitations encore lisibles
api.post('/users', adminOnly, wrap(async (req) => {
  const b = { role: 'office', ...req.body };
  const data = userData(b, true);
  if (data.role === 'office' && data.permissions === undefined) data.permissions = JSON.stringify(PRESETS.bureau.perms);
  const id = insert('users', data, USER_COLS);
  // Si l'e-mail ne part pas, le lien est quand même créé et renvoyé (le gérant peut le copier)
  const invite = b.invite && data.email && !data.password_hash
    ? await inviteUser(req, id, b.send_invite).catch(async (e) => ({ ...(await inviteUser(req, id, false).catch(() => ({}))), error: e.message }))
    : null;
  return { id, invite };
}));
api.put('/users/:id', adminOnly, wrap((req) => {
  const id = Number(req.params.id);
  const cur = get('SELECT * FROM users WHERE id=?', id);
  if (!cur) throw new BusinessError('Utilisateur introuvable', 404);
  const b = { ...req.body, id };
  const data = userData(b, false, cur);
  const off = data.active === 0, demoted = data.role !== undefined && data.role !== 'admin';
  if (id === req.user.id && (off || demoted)) throw new BusinessError('Vous ne pouvez pas désactiver votre propre compte admin');
  // Il doit toujours rester un gérant actif (sinon plus personne ne peut administrer le logiciel)
  if (cur.role === 'admin' && (off || demoted) && !get("SELECT 1 FROM users WHERE role='admin' AND active=1 AND id!=?", id)) throw new BusinessError('Il doit rester au moins un administrateur actif');
  update('users', id, data, USER_COLS);
  // Un ancien lien d'invitation ne doit plus servir après un changement de mot de passe, d'e-mail ou de statut
  if (data.password_hash || off || (data.email !== undefined && data.email !== cur.email) || (data.role !== undefined && data.role !== cur.role)) clearInvite(id);
  // Déconnexion des autres appareils (la session du gérant qui modifie son propre mot de passe est gardée)
  if (off || data.password_hash || data.role === 'mechanic') run("DELETE FROM sessions WHERE user_id=? AND COALESCE(kind,'web')!='kiosk' AND token!=?", id, id === req.user.id ? req.user.token : '');
  if (off || data.pin_hash) run("DELETE FROM sessions WHERE user_id=? AND kind='kiosk'", id);
  return { ok: true };
}));
api.post('/users/:id/invite', adminOnly, wrap((req) => inviteUser(req, Number(req.params.id), req.body.send)));
api.get('/me', (req, res) => {
  const { permissions, token, ...u } = req.user;
  res.json({ ...u, perms: effectivePerms(req.user), attendance: statusOf(req.user.id) });
});

// ---------- Présences (pointage façon Odoo) ----------
api.get('/attendance/me', (req, res) => res.json(statusOf(req.user.id)));
api.post('/attendance/check', wrap((req) => checkInOut(req.user.id, { action: req.body.action, source: 'web' })));
api.get('/attendance/board', (req, res) => res.json(board()));
api.get('/attendance/report', (req, res) => res.json(attendanceReport(req.query)));
api.get('/attendance', (req, res) => res.json(listAttendance(req.query)));
api.post('/attendance', needManager('presences'), wrap((req) => ({ id: saveAttendance(req.body) })));
api.put('/attendance/:id', needManager('presences'), wrap((req) => ({ id: saveAttendance({ ...req.body }, Number(req.params.id)) })));
api.delete('/attendance/:id', needManager('presences'), wrap((req) => { run("DELETE FROM time_entries WHERE id=? AND kind='presence'", req.params.id); return { ok: true }; }));
const publicSettings = () => { const { odoo, smtp, bills_inbox, bills_inbox_status, copilot, social, ...s } = getSettings(); return { ...s, options: options(), attendance: attendanceConfig(), home: s.home || {} }; };
api.get('/settings', (req, res) => res.json(publicSettings()));
api.put('/settings', adminOnly, wrap((req) => {
  if (req.body.workshop !== undefined) {
    // Valeurs de l'atelier contrôlées : un champ vidé par erreur donnerait des lignes sans TVA ou une échéance avant la facture
    const w = { ...getSettings().workshop, ...(req.body.workshop || {}) };
    const n = (v) => (v === '' || v === null || v === undefined ? NaN : Number(String(v).replace(',', '.')));
    if (!(n(w.labor_rate) >= 0)) throw new BusinessError('Taux horaire : indiquez un nombre (0 ou plus)');
    if (!(n(w.default_tax) >= 0 && n(w.default_tax) <= 100)) throw new BusinessError('TVA par défaut : indiquez un taux entre 0 et 100');
    if (!(Number.isInteger(n(w.payment_terms)) && n(w.payment_terms) >= 0)) throw new BusinessError('Délai de paiement : nombre de jours entier, 0 ou plus');
    if (!(Number.isInteger(n(w.bays)) && n(w.bays) >= 1)) throw new BusinessError('Nombre de ponts : au moins 1');
    for (const k of ['opening', 'closing']) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(w[k] || ''))) throw new BusinessError('Horaires : format HH:MM (exemple 08:00)');
    if (w.closing <= w.opening) throw new BusinessError('L\'heure de fermeture doit être après l\'heure d\'ouverture');
    req.body.workshop = { ...w, labor_rate: n(w.labor_rate), default_tax: n(w.default_tax), payment_terms: n(w.payment_terms), bays: n(w.bays) };
  }
  if (req.body.public_url !== undefined) {
    const url = String(req.body.public_url || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url) && !/^https?:\/\/(localhost|[\d.]+)(:\d+)?$/i.test(url)) throw new BusinessError('Adresse publique : elle doit commencer par https:// (exemple : https://atelier.mon-garage.lu)');
    req.body.public_url = url;
  }
  if (req.body.company !== undefined && !String(req.body.company?.name || '').trim()) throw new BusinessError('Le nom de la société est obligatoire');
  for (const k of ['company', 'workshop', 'numbering', 'invoice_footer', 'ai', 'public_url']) if (req.body[k] !== undefined) setSetting(k, req.body[k]);
  if (req.body.layout) setSetting('layout', cleanLayout(req.body.layout));
  if (req.body.options) setSetting('options', cleanOptions(req.body.options));
  if (req.body.attendance) {
    const a = req.body.attendance;
    setSetting('attendance', {
      hours_per_day: Math.min(24, Math.max(0, Number(a.hours_per_day) || ATTENDANCE_DEFAULTS.hours_per_day)),
      work_days: Array.isArray(a.work_days) ? [...new Set(a.work_days.map(Number).filter((d) => d >= 0 && d <= 6))] : ATTENDANCE_DEFAULTS.work_days,
      tolerance_min: Math.max(0, Number(a.tolerance_min) || 0),
      auto_checkout: Boolean(a.auto_checkout), kiosk_pin: Boolean(a.kiosk_pin), kiosk_badge: Boolean(a.kiosk_badge), kiosk_show_orders: Boolean(a.kiosk_show_orders),
    });
  }
  return publicSettings();
}));
// ---------- CRM ----------
api.get('/crm/meta', (req, res) => res.json({ stages: stages(), sources: SOURCES, lost_reasons: LOST_REASONS }));
api.get('/crm/stats', (req, res) => res.json(pipelineStats()));
api.get('/crm/leads', (req, res) => res.json(listLeads(req.query)));
api.get('/crm/leads/:id', wrap((req) => getLead(Number(req.params.id))));
api.post('/crm/leads', wrap((req) => ({ id: saveLead({ user_id: req.user.id, ...req.body }) })));
api.put('/crm/leads/:id', wrap((req) => ({ id: saveLead(req.body, Number(req.params.id)) })));
api.delete('/crm/leads/:id', wrap((req) => { tx(() => { run('DELETE FROM crm_leads WHERE id=?', req.params.id); forgetRecord('lead', Number(req.params.id)); }); return { ok: true }; }));
api.post('/crm/leads/:id/move', wrap((req) => moveLead(Number(req.params.id), Number(req.body.stage_id), Number(req.body.sequence) || 0)));
api.post('/crm/leads/:id/won', wrap((req) => markWon(Number(req.params.id))));
api.post('/crm/leads/:id/lost', wrap((req) => markLost(Number(req.params.id), req.body.reason)));
api.post('/crm/leads/:id/restore', wrap((req) => restoreLead(Number(req.params.id))));
api.post('/crm/leads/:id/customer', wrap((req) => { if (!can(req.user, 'contacts', 'user')) throw new BusinessError('Droit « Utilisateur » sur Contacts requis', 403); return { customer_id: ensureCustomer(Number(req.params.id)) }; }));
api.post('/crm/leads/:id/quote', wrap((req) => { if (!can(req.user, 'ventes', 'user')) throw new BusinessError('Droit « Utilisateur » sur Ventes requis', 403); return { document_id: createQuote(Number(req.params.id)) }; }));
api.post('/crm/stages', needManager('crm'), wrap((req) => ({ id: saveStage(req.body) })));
api.put('/crm/stages/:id', needManager('crm'), wrap((req) => ({ id: saveStage(req.body, Number(req.params.id)) })));
api.delete('/crm/stages/:id', wrap((req) => { deleteStage(Number(req.params.id)); return { ok: true }; }));

// ---------- Site web ----------
api.get('/website', (req, res) => res.json({ config: websiteConfig(), types: BLOCK_TYPES, url: `${baseUrl(req)}/site` }));
api.put('/website', wrap((req) => {
  if ('published' in req.body && Boolean(req.body.published) !== websiteConfig().published && !can(req.user, 'site', 'manager')) throw new BusinessError('Seul un administrateur du site peut le publier ou le dépublier', 403);
  return saveWebsite(req.body);
}));
api.post('/website/preview', wrap((req, res) => { res.type('html').send(renderSite({ preview: true })); }));
api.post('/website/generate', wrap((req) => generateWebsite(req.body || {})));
api.post('/website/images', rawBody, wrap((req) => saveSiteImage(Buffer.isBuffer(req.body) ? req.body : null)));

// ---------- Marketing social ----------
api.get('/social', (req, res) => res.json({ platforms: PLATFORMS, accounts: publicAccounts(), public_url: getSettings().public_url || '' }));
api.put('/social/accounts', needManager('social'), wrap((req) => saveAccounts(req.body)));
api.get('/social/posts', (req, res) => res.json(listPosts(req.query)));
api.post('/social/posts', wrap((req) => getPost(savePost(req.body, req.user.id))));
api.put('/social/posts/:id', wrap((req) => getPost(savePost(req.body, req.user.id, Number(req.params.id)))));
api.delete('/social/posts/:id', wrap((req) => { run('DELETE FROM social_posts WHERE id=?', req.params.id); return { ok: true }; }));
api.post('/social/posts/:id/publish', wrap((req) => publishPost(Number(req.params.id), getSettings().public_url)));
api.post('/social/posts/:id/manual-done', wrap((req) => markManualDone(Number(req.params.id))));
api.post('/social/write', wrap((req) => writePosts(req.body || {})));
api.post('/social/ideas', wrap(() => postIdeas()));
api.post('/social/images', rawBody, wrap((req) => saveSiteImage(Buffer.isBuffer(req.body) ? req.body : null)));

api.post('/settings/home-bg', adminOnly, rawBody, wrap((req) => saveBackground(Buffer.isBuffer(req.body) ? req.body : null)));
api.delete('/settings/home-bg', adminOnly, wrap(() => deleteBackground()));
api.post('/automation/followups', adminOnly, wrap(() => runFollowups({ force: true })));
api.post('/automation/reminders', adminOnly, wrap(() => runAppointmentReminders({ force: true })));

// ---------- Import Odoo ----------
api.get('/odoo', adminOnly, (req, res) => res.json({ config: publicOdooConfig(), job: odooJob, last: getSettings().odoo_last_import || null }));
api.put('/odoo', adminOnly, wrap((req) => { saveOdooConfig(req.body); return { config: publicOdooConfig() }; }));
api.post('/odoo/test', adminOnly, wrap(() => testConnection()));
api.post('/odoo/import', adminOnly, wrap((req) => {
  if (odooJob.running) throw new BusinessError('Un import est déjà en cours');
  runImport(req.body?.options);
  return odooJob;
}));

mountLive(app, api);

// ---------- E-mails ----------
const checkModel = (m) => { if (m && !MODELS.includes(m)) throw new BusinessError('Type de fiche inconnu'); return m || null; };
api.get('/mail/config', (req, res) => res.json(publicMailConfig()));
api.put('/mail/config', adminOnly, wrap((req) => { saveMailConfig(req.body); return publicMailConfig(); }));
api.post('/mail/test', adminOnly, wrap(() => testMail()));
api.get('/mail/compose', wrap((req) => compose(checkModel(req.query.model), Number(req.query.id) || null, req.query.template, publicUrl(req))));
// Logo du garage (documents, e-mails, suivi client)
api.post('/settings/logo', adminOnly, rawBody, wrap((req) => saveLogo(Buffer.isBuffer(req.body) ? req.body : null)));
api.delete('/settings/logo', adminOnly, wrap(() => deleteLogo()));
api.get('/qr.svg', wrap(async (req, res) => {
  const text = String(req.query.text || '').slice(0, 500);
  if (!text.trim()) return res.status(204).end();
  res.type('image/svg+xml').send(await QRCode.toString(text, { type: 'svg', margin: 1 }));
}));
api.post('/mail/preview', wrap(async (req) => {
  const { html } = await renderEmail({ model: checkModel(req.body.model), record_id: Number(req.body.record_id) || null, intro: req.body.intro || '', include_document: req.body.include_document });
  return { html: html.replace('cid:qrpay', `/api/documents/${Number(req.body.record_id)}/qr.svg`).replace('cid:garagelogo', '/logo') };
}));
api.post('/mail/send', wrap((req) => sendEmail({ ...req.body, model: checkModel(req.body.model), record_id: Number(req.body.record_id) || null, user_id: req.user.id })));
// Boîte d'envoi : le gérant voit tout ; les autres voient leurs propres e-mails et ceux des fiches qu'ils ont le droit de lire
api.get('/mail/outbox', (req, res) => {
  const u = req.user, admin = u.role === 'admin';
  res.json(all(`SELECT e.*, u.name AS user_name FROM emails e LEFT JOIN users u ON u.id=e.user_id ${admin ? '' : "WHERE COALESCE(e.model,'')!='user'"} ORDER BY e.id DESC LIMIT 300`)
    .filter((e) => admin || e.user_id === u.id || (e.model && canReadRecord(u, e.model, e.record_id)))
    .map((e) => ({ ...e, record: recordInfo(e.model, e.record_id) })));
});
api.delete('/mail/:id', wrap((req) => {
  const e = get("SELECT * FROM emails WHERE id=? AND status='scheduled'", req.params.id);
  if (!e) throw new BusinessError('Seul un e-mail programmé peut être annulé');
  run("UPDATE emails SET status='cancelled' WHERE id=?", e.id);
  logMessage(e.model, e.record_id, `🚫 E-mail programmé annulé : « ${e.subject} »`, req.user.id, 'system');
  return { ok: true };
}));
// Rédaction assistée : Sophie (secrétariat) écrit le texte du mail
api.post('/mail/draft-ai', wrap(async (req) => {
  // Sans clé API, l'agent répond par un avertissement « mode démo » : il ne doit pas remplacer le texte de l'utilisateur
  if (!aiConfigured()) throw new BusinessError('Rédaction par l\'IA indisponible : aucune clé Claude n\'est configurée (voir README → Activer les agents IA).');
  const info = recordInfo(checkModel(req.body.model), Number(req.body.record_id)) || {};
  const prompt = `Rédige le texte d'un e-mail professionnel à envoyer par le garage${info.name ? ` à ${info.name}` : ''}.
Contexte : ${info.label || 'aucune fiche liée'}. Objet prévu : ${req.body.subject || '—'}.
Consigne du gérant : ${req.body.instruction || 'améliore et rends plus chaleureux le texte actuel'}.
Texte actuel :
${req.body.intro || ''}

Réponds UNIQUEMENT avec le corps du message en texte brut (salutation, contenu, formule de politesse), sans objet ni commentaire. Si besoin, consulte les données avec tes outils.`;
  let intro;
  try { intro = await runAgent('secretariat', [{ role: 'user', content: prompt }], { user: req.user }); } catch (e) { throw new BusinessError(friendlyError(e)); }
  if (!intro?.trim() || /^\(pas de réponse\)|^⚠️/.test(intro.trim())) throw new BusinessError('L\'IA n\'a pas pu rédiger ce message. Réessayez ou écrivez-le vous-même.');
  return { intro };
}));

// ---------- Historique & activités (sur chaque fiche) ----------
api.get('/chatter/:model/:id', wrap((req) => chatter(checkModel(req.params.model), Number(req.params.id))));
api.post('/chatter/:model/:id/note', wrap((req) => {
  if (!req.body.body?.trim()) throw new BusinessError('Note vide');
  logMessage(checkModel(req.params.model), Number(req.params.id), req.body.body.trim(), req.user.id, 'note');
  return { ok: true };
}));
api.get('/activities/meta', (req, res) => res.json({ modules: MODULES, types: ACTIVITY_TYPES, templates: TEMPLATE_LABELS }));
api.get('/activities/counts', (req, res) => res.json(activityCounts(req.user.id)));
// La fiche liée (nom du client, e-mail…) n'est montrée qu'à ceux qui ont le droit de la lire
const canReadRecord = (u, model, id) => { const app = recordApp(model, id); return !app || can(u, app, 'read'); };
api.get('/activities', (req, res) => {
  const one = (v) => (Array.isArray(v) ? v[0] : v) || null; // un paramètre répété dans l'adresse : on garde le premier
  const q = Object.fromEntries(['user_id', 'module', 'model', 'record_id', 'status', 'scope', 'mine'].map((k) => [k, one(req.query[k])]));
  if (q.model && !canReadRecord(req.user, q.model, q.record_id)) return res.status(403).json({ error: 'Accès refusé à cette fiche' });
  res.json(listActivities({
    user_id: q.mine ? req.user.id : q.user_id, module: q.module,
    model: q.model, record_id: q.record_id, status: q.status || 'planned', scope: q.scope,
  }).filter((a) => req.user.role === 'admin' || a.user_id === req.user.id || a.created_by === req.user.id || (a.model && canReadRecord(req.user, a.model, a.record_id))));
});
api.post('/activities', wrap((req) => ({ id: createActivity({ ...req.body, model: checkModel(req.body.model) }, req.user.id) })));
// Modifier, terminer ou annuler une activité : la personne à qui elle est confiée, celle qui l'a créée,
// ou quelqu'un qui a le droit « Utilisateur » sur la fiche concernée
function ownActivity(req) {
  const a = get('SELECT * FROM activities WHERE id=?', req.params.id);
  if (!a) throw new BusinessError('Activité introuvable', 404);
  const u = req.user, app = recordApp(a.model, a.record_id);
  if (u.role !== 'admin' && a.user_id !== u.id && a.created_by !== u.id && !(app && can(u, app, 'user'))) throw new BusinessError('Cette activité est confiée à quelqu\'un d\'autre', 403);
  return a;
}
api.put('/activities/:id', wrap((req) => { ownActivity(req); update('activities', req.params.id, req.body, ACTIVITY_COLS.filter((c) => !['created_by', 'model', 'record_id'].includes(c))); return { ok: true }; }));
api.post('/activities/:id/done', wrap((req) => { ownActivity(req); return completeActivity(Number(req.params.id), req.body?.feedback, req.user.id); }));
api.delete('/activities/:id', wrap((req) => { ownActivity(req); run("UPDATE activities SET status='cancelled' WHERE id=?", req.params.id); return { ok: true }; }));

// ---------- Copilote Nova : écoute, journal, résumé de fin de journée ----------
// Le résumé de fin de journée (chiffres de tout le garage) est destiné au gérant
api.get('/copilot', (req, res) => res.json({ config: copilotConfig(), journal: journalOf(req.query.date || today()), briefs: req.user.role === 'admin' ? listBriefs(Number(req.query.limit) || 14) : [], ai: aiConfigured() }));
api.put('/copilot/config', adminOnly, wrap((req) => { saveCopilotConfig(req.body); return copilotConfig(); }));
api.post('/copilot/journal', wrap((req) => ({ id: addJournal(req.body.text, req.user.id, req.body.source === 'voice' ? 'voice' : 'text') })));
api.delete('/copilot/journal/:id', wrap((req) => {
  const j = get('SELECT user_id FROM journal WHERE id=?', req.params.id);
  if (j && req.user.role !== 'admin' && j.user_id !== req.user.id) throw new BusinessError('Seul l\'auteur de la note (ou le gérant) peut la supprimer', 403);
  run('DELETE FROM journal WHERE id=?', req.params.id);
  return { ok: true };
}));
api.post('/copilot/chat', wrap((req) => copilotChat(req.user, req.body.message, req.body.history || [])));
api.post('/copilot/brief', adminOnly, wrap((req) => generateBrief({ date: isDate(req.body.date) ? req.body.date : today(), force: true })));
api.get('/copilot/stats', (req, res) => res.json(dayStats(isDate(req.query.date) ? req.query.date : today(), req.user)));

// ---------- Bureau virtuel IA ----------
// Chaque utilisateur a ses propres conversations, tâches et rapports ; le gérant voit tout
// (un rapport ou une tâche sans propriétaire — créé avant cette règle ou par le système — appartient au gérant).
const isAdmin = (u) => u.role === 'admin';
const mineSql = (u, col) => (isAdmin(u) ? '1=1' : `${col}=${Number(u.id)}`);
const ownRow = (req, table, col, label) => {
  const r = get(`SELECT * FROM ${table} WHERE id=?`, req.params.id);
  if (!r || (!isAdmin(req.user) && r[col] !== req.user.id)) throw new BusinessError(`${label} introuvable`, 404);
  return r;
};
api.get('/agents', (req, res) => res.json(AGENTS.map(({ prompt, ...a }) => ({
  ...a, working: running.has(a.id),
  unread: get(`SELECT COUNT(*) n FROM agent_results WHERE agent_id=? AND read=0 AND ${mineSql(req.user, 'user_id')}`, a.id).n,
  tasks: get(`SELECT COUNT(*) n FROM agent_tasks WHERE agent_id=? AND active=1 AND ${mineSql(req.user, 'created_by')}`, a.id).n,
}))));
api.get('/agents/:id/messages', (req, res) => {
  const c = listConversations({ agent: req.params.id, limit: 1, user: req.user })[0];
  res.json(c ? conversationMessages(c.id) : []);
});
api.delete('/agents/:id/messages', (req, res) => { clearHistory(req.params.id, req.user); res.json({ ok: true }); });
api.post('/agents/:id/chat', wrap(async (req) => {
  if (typeof req.body.message !== 'string' || !req.body.message.trim()) throw new BusinessError('Message vide');
  if (!AGENTS.some((a) => a.id === req.params.id)) throw new BusinessError('Agent inconnu', 404);
  running.add(req.params.id);
  try { return await chat(req.params.id, req.body.message.trim(), Number(req.body.conversation_id) || null, req.user); } finally { running.delete(req.params.id); }
}));
// Historique des conversations (consultable, recherche plein texte)
api.get('/agent-conversations', (req, res) => res.json(listConversations({ agent: req.query.agent && String(req.query.agent), q: req.query.q && String(req.query.q), limit: Math.min(Number(req.query.limit) || 60, 200), user: req.user })));
const ownConversation = (req) => {
  const c = getConversation(req.params.cid);
  if (!ownsConversation(c, req.user)) throw new BusinessError('Conversation introuvable', 404);
  return c;
};
api.get('/agent-conversations/:cid', wrap((req) => { const c = ownConversation(req); return { ...c, messages: conversationMessages(c.id) }; }));
api.put('/agent-conversations/:cid', wrap((req) => { updateConversation(ownConversation(req).id, req.body); return { ok: true }; }));
api.delete('/agent-conversations/:cid', wrap((req) => { deleteConversation(ownConversation(req).id); return { ok: true }; }));
api.post('/agents/meeting', wrap(async (req) => {
  if (typeof req.body.question !== 'string' || !req.body.question.trim()) throw new BusinessError('Question vide');
  AGENTS.forEach((a) => running.add(a.id));
  try { return await meeting(req.body.question.trim(), req.user); } finally { AGENTS.forEach((a) => running.delete(a.id)); }
}));
const TASK_COLS = ['agent_id', 'title', 'prompt', 'schedule_type', 'schedule_time', 'schedule_day', 'run_at', 'next_run', 'active'];
const SCHEDULES = ['once', 'daily', 'weekdays', 'weekly', 'monthly'];
function checkTask(t) {
  if (!t.agent_id || !t.title || !t.prompt) throw new BusinessError('Agent, titre et consigne requis');
  if (!AGENTS.some((a) => a.id === t.agent_id)) throw new BusinessError('Agent inconnu');
  if (!SCHEDULES.includes(t.schedule_type || 'once')) throw new BusinessError('Fréquence inconnue');
  if (t.schedule_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.schedule_time)) throw new BusinessError('Heure invalide (format HH:MM)');
  if (t.run_at && Number.isNaN(new Date(t.run_at).getTime())) throw new BusinessError('Date d\'exécution invalide');
}
api.get('/agent-tasks', (req, res) => res.json(all(`SELECT * FROM agent_tasks WHERE ${mineSql(req.user, 'created_by')} ${req.query.agent ? 'AND agent_id=?' : ''} ORDER BY active DESC, next_run`, ...(req.query.agent ? [String(req.query.agent)] : []))));
api.post('/agent-tasks', wrap((req) => {
  const t = { active: 1, ...req.body, created_by: req.user.id };
  checkTask(t);
  t.next_run = computeNextRun(t);
  return { id: insert('agent_tasks', t, [...TASK_COLS, 'created_by']) };
}));
api.put('/agent-tasks/:id', wrap((req) => {
  const cur = ownRow(req, 'agent_tasks', 'created_by', 'Tâche');
  const t = { ...cur, ...req.body, created_by: cur.created_by };
  checkTask(t);
  // Tâche « une seule fois » déjà exécutée : une nouvelle date (ou sa réactivation) la reprogramme vraiment
  const rearm = t.schedule_type === 'once' && ((req.body.run_at && req.body.run_at !== cur.run_at) || (t.active && !cur.active));
  if (rearm) { t.last_run = null; run('UPDATE agent_tasks SET last_run=NULL WHERE id=?', cur.id); }
  t.next_run = t.active ? computeNextRun(t) : null;
  if (t.active && t.schedule_type === 'once' && !t.next_run) throw new BusinessError('Choisissez une date à venir pour relancer cette tâche.');
  update('agent_tasks', req.params.id, t, TASK_COLS);
  return { ok: true };
}));
api.delete('/agent-tasks/:id', wrap((req) => { run('DELETE FROM agent_tasks WHERE id=?', ownRow(req, 'agent_tasks', 'created_by', 'Tâche').id); return { ok: true }; }));
api.post('/agent-tasks/:id/run', wrap(async (req) => {
  const t = ownRow(req, 'agent_tasks', 'created_by', 'Tâche');
  if (running.has(t.agent_id)) throw new BusinessError('Cet agent est déjà occupé');
  return { content: await executeTask(t) };
}));
api.get('/agent-results', (req, res) => res.json(all(`SELECT * FROM agent_results WHERE ${mineSql(req.user, 'user_id')} ${req.query.agent ? 'AND agent_id=?' : ''} ORDER BY id DESC LIMIT 100`, ...(req.query.agent ? [String(req.query.agent)] : []))));
api.post('/agent-results/:id/read', wrap((req) => { run('UPDATE agent_results SET read=1 WHERE id=?', ownRow(req, 'agent_results', 'user_id', 'Rapport').id); return { ok: true }; }));
api.delete('/agent-results/:id', wrap((req) => { run('DELETE FROM agent_results WHERE id=?', ownRow(req, 'agent_results', 'user_id', 'Rapport').id); return { ok: true }; }));

// ---------- Erreurs ----------
app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.resolve('public/index.html')));
api.use((req, res) => res.status(404).json({ error: 'Route inconnue' }));
app.use((err, req, res, _next) => {
  if (err instanceof BusinessError) return res.status(err.status || 400).json({ error: err.message });
  // Requête mal formée (JSON invalide, fichier trop gros…) : erreur du client, pas du serveur
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Requête illisible (JSON invalide)' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Fichier ou message trop volumineux' });
  // Contraintes de la base (champ obligatoire vide, fiche liée absente…) : message compréhensible, sans texte SQL
  if (err.code === 'ERR_SQLITE_ERROR' && /constraint failed/i.test(err.message || '')) {
    const m = /NOT NULL constraint failed: \w+\.(\w+)/.exec(err.message);
    return res.status(400).json({ error: m ? `Champ obligatoire : ${label(m[1])}` : /FOREIGN KEY/.test(err.message) ? 'Une fiche liée est introuvable ou encore utilisée ailleurs.' : 'Enregistrement impossible : cette valeur existe déjà.' });
  }
  console.error(err);
  res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.status && err.status < 500 ? err.message : 'Erreur interne du logiciel. Réessayez ; si le problème persiste, consultez le journal du serveur.' });
});

const PORT = Number(process.env.PORT || 3000);
// Les tâches de fond (e-mails programmés, relances, boîte factures…) ne démarrent qu'une fois le logiciel réellement démarré :
// un deuxième lancement par erreur ne doit pas envoyer les e-mails une deuxième fois
function startBackgroundJobs() {
  purgeSessions();
  recoverInterruptedEmails();
  setInterval(() => { try { purgeSessions(); } catch (e) { console.error('Sessions', e); } }, 24 * 3600e3).unref();
  startScheduler();
  startAutomation();
  startInboxPolling();
  startCopilotScheduler();
  setInterval(() => processScheduledEmails().catch((e) => console.error('E-mails programmés', e)), 30_000);
}
// Les modifications passent d'abord par garage.db-wal : on les recopie régulièrement dans garage.db,
// et à l'arrêt (Ctrl+C, arrêt du conteneur Docker) pour que garage.db soit toujours complet.
setInterval(() => { try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch {} }, 5 * 60_000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch {} process.exit(0); });
}
app.listen(PORT, (err) => {
  if (err) {
    console.error(err.code === 'EADDRINUSE'
      ? `\n⚠️  Le port ${PORT} est déjà utilisé : le logiciel est probablement déjà démarré (ouvrez http://localhost:${PORT}).\n    Sinon, fermez l'autre programme ou choisissez un autre port (PORT=3001 dans le fichier .env).`
      : `\n⚠️  Démarrage impossible : ${err.message}`);
    process.exit(1);
  }
  startBackgroundJobs();
  console.log(`\n🚗  Garage — logiciel de gestion démarré : http://localhost:${PORT}`);
  console.log(`🔧  Pointage atelier (tablette) : http://localhost:${PORT}/kiosk.html`);
  console.log(aiConfigured() ? '🤖  Agents IA : actifs' : '🤖  Agents IA : mode démo (ajoutez ANTHROPIC_API_KEY dans .env)');
  if (get("SELECT COUNT(*) n FROM users WHERE role='admin'").n === 0) console.log(`🔑  Code d'installation (seulement pour créer le compte du gérant depuis internet) : ${SETUP_CODE}`);
});
