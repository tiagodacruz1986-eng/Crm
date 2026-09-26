// Droits d'accès par application (comme Odoo) : Aucun / Lecture seule / Utilisateur / Administrateur.
// Le gérant (rôle admin) a tous les droits ; les mécaniciens n'utilisent que le kiosque de pointage.
import crypto from 'node:crypto';
import { db, all, get, run } from './db.js';

if (!all('PRAGMA table_info(users)').some((c) => c.name === 'permissions')) {
  db.exec('ALTER TABLE users ADD COLUMN permissions TEXT');
  db.exec('ALTER TABLE users ADD COLUMN job_title TEXT');
  db.exec('ALTER TABLE users ADD COLUMN invite_hash TEXT');
  db.exec('ALTER TABLE users ADD COLUMN invite_expires TEXT');
  db.exec('ALTER TABLE users ADD COLUMN last_login TEXT');
}

export const LEVELS = ['none', 'read', 'user', 'manager'];
export const LEVEL_LABELS = { none: 'Aucun accès', read: 'Lecture seule', user: 'Utilisateur', manager: 'Administrateur' };

export const APPS = [
  { key: 'ventes', name: 'Ventes', desc: 'Devis, factures, avoirs, encaissements' },
  { key: 'atelier', name: 'Atelier', desc: 'Ordres de réparation, planning, rendez-vous, suivi en direct' },
  { key: 'contacts', name: 'Contacts', desc: 'Clients et fournisseurs' },
  { key: 'vehicules', name: 'Parc automobile', desc: 'Véhicules des clients' },
  { key: 'inventaire', name: 'Inventaire', desc: 'Articles, stock, mouvements, réapprovisionnement' },
  { key: 'achats', name: 'Achats', desc: 'Commandes et factures fournisseurs' },
  { key: 'banque', name: 'Banque', desc: 'Relevés, rapprochements, paiements' },
  { key: 'comptabilite', name: 'Comptabilité', desc: 'Écritures, TVA, balance, grand livre' },
  { key: 'presences', name: 'Présences', desc: 'Pointages de toute l\'équipe, feuilles de temps' },
  { key: 'crm', name: 'CRM', desc: 'Pistes, opportunités, pipeline commercial' },
  { key: 'site', name: 'Site web', desc: 'Créer et publier la page web du garage' },
  { key: 'social', name: 'Marketing social', desc: 'Publications Facebook, Instagram…' },
  { key: 'ia', name: 'IA', desc: 'Nova, bureau IA, agents' },
  { key: 'emails', name: 'Discussion & e-mails', desc: 'Envoyer des e-mails, boîte d\'envoi' },
];

// Modèles de droits prêts à l'emploi
const all_ = (lvl) => Object.fromEntries(APPS.map((a) => [a.key, lvl]));
export const PRESETS = {
  bureau: { name: 'Bureau / accueil', perms: { ...all_('user'), comptabilite: 'read', banque: 'read', presences: 'read' } },
  marketing: { name: 'Commercial / marketing', perms: { ...all_('none'), crm: 'manager', site: 'manager', social: 'manager', contacts: 'user', vehicules: 'read', ventes: 'user', emails: 'user', ia: 'user' } },
  chef_atelier: { name: 'Chef d\'atelier', perms: { ...all_('none'), atelier: 'manager', contacts: 'user', vehicules: 'user', inventaire: 'user', achats: 'user', presences: 'manager', ventes: 'read', ia: 'user', emails: 'user' } },
  comptable: { name: 'Comptable / fiduciaire', perms: { ...all_('read'), comptabilite: 'manager', banque: 'user', achats: 'user', atelier: 'none', ia: 'none', emails: 'user' } },
  magasinier: { name: 'Magasinier', perms: { ...all_('none'), inventaire: 'manager', achats: 'user', contacts: 'read', vehicules: 'read', atelier: 'read' } },
  lecture: { name: 'Lecture seule (associé, conseiller)', perms: { ...all_('read'), ia: 'none', emails: 'none' } },
  admin: { name: 'Administrateur de tout', perms: all_('manager') },
};

// Droits induits (comme Odoo) : travailler dans une application demande de lire certaines autres
const IMPLIES = {
  ventes: ['contacts', 'vehicules', 'inventaire'],
  crm: ['contacts', 'vehicules'],
  atelier: ['contacts', 'vehicules', 'inventaire'],
  achats: ['contacts', 'inventaire'],
  banque: ['ventes', 'achats', 'contacts'],
  comptabilite: ['ventes', 'achats', 'banque', 'contacts'],
};
const rank = (l) => Math.max(0, LEVELS.indexOf(l));

export function normalizePerms(p) {
  const src = typeof p === 'string' ? (() => { try { return JSON.parse(p); } catch { return {}; } })() : p || {};
  return Object.fromEntries(APPS.map((a) => [a.key, LEVELS.includes(src[a.key]) ? src[a.key] : 'none']));
}

/** Droits effectifs d'un utilisateur (droits induits compris). */
export function effectivePerms(user) {
  if (!user) return all_('none');
  if (user.role === 'admin') return all_('manager');
  if (user.role === 'mechanic') return { ...all_('none') };
  const own = normalizePerms(user.permissions ?? get('SELECT permissions FROM users WHERE id=?', user.id)?.permissions ?? PRESETS.bureau.perms);
  const eff = { ...own };
  for (const [app, implied] of Object.entries(IMPLIES)) {
    if (rank(own[app]) >= rank('user')) for (const i of implied) if (rank(eff[i]) < rank('read')) eff[i] = 'read';
  }
  return eff;
}
export const can = (user, app, level = 'read') => rank(effectivePerms(user)[app]) >= rank(level);

// ---------- Quelle application protège quelle route ----------
const PREFIXES = [
  ['/documents', null], ['/appointments', 'atelier'], ['/live', 'atelier'],
  ['/customers', 'contacts'], ['/suppliers', 'contacts'], ['/vehicles', 'vehicules'],
  ['/products', 'inventaire'], ['/stock', 'inventaire'],
  ['/purchases', 'achats'], ['/bills', 'achats'],
  ['/bank-accounts', 'banque'], ['/bank', 'banque'], ['/payments', 'banque'],
  ['/accounting', 'comptabilite'],
  ['/timesheets', 'presences'], ['/attendance', 'presences'],
  ['/agents', 'ia'], ['/agent-', 'ia'], ['/copilot', 'ia'],
  ['/mail', 'emails'],
  ['/crm', 'crm'], ['/website', 'site'], ['/social', 'social'],
];
// Routes accessibles à tout utilisateur connecté (lecture de son propre pointage, recherche filtrée…)
const OPEN = [/^\/attendance\/me$/, /^\/attendance\/check$/, /^\/mail\/(compose|preview)$/, /^\/copilot\/journal/];
const READ_POSTS = [/^\/website\/preview$/, /^\/mail\/preview$/, /^\/documents\/\d+\/qr\.svg$/];

function documentApp(req) {
  const typeApp = (t) => (t === 'order' ? 'atelier' : t ? 'ventes' : null);
  const m = /^\/documents\/(\d+)/.exec(req.path);
  if (m) return typeApp(get('SELECT type FROM documents WHERE id=?', Number(m[1]))?.type) || 'ventes';
  return typeApp(req.query.type || req.body?.type) || 'ventes';
}

export function requiredAccess(req) {
  if (OPEN.some((r) => r.test(req.path))) return null;
  const hit = PREFIXES.find(([p]) => (p.endsWith('-') ? req.path.startsWith(p) : req.path === p || req.path.startsWith(p + '/')));
  if (!hit) return null;
  const app = hit[1] || documentApp(req);
  let level = req.method === 'GET' || req.method === 'HEAD' || READ_POSTS.some((r) => r.test(req.path)) ? 'read' : req.method === 'DELETE' ? 'manager' : 'user';
  const extra = [];
  // Convertir un OR en facture (ou un devis en OR) demande aussi les droits sur l'application cible
  if (/^\/documents\/\d+\/convert$/.test(req.path) && req.body?.type) extra.push([req.body.type === 'order' ? 'atelier' : 'ventes', 'user']);
  if (/^\/documents\/\d+\/payments$/.test(req.path)) extra.push(['banque', 'user']);
  return [[app, level], ...extra];
}

/** Middleware : refuse l'accès si l'utilisateur n'a pas le niveau requis sur l'application. */
export function accessGuard(req, res, next) {
  const u = req.user;
  if (!u) return next();
  if (u.session_kind === 'kiosk' && !req.path.startsWith('/kiosk')) return res.status(403).json({ error: 'Session kiosque : accès limité au pointage' });
  if (u.role === 'admin') return next();
  const need = requiredAccess(req);
  if (!need) return next();
  for (const [app, level] of need) {
    if (!can(u, app, level)) {
      const a = APPS.find((x) => x.key === app);
      return res.status(403).json({ error: `Accès refusé : il faut le droit « ${LEVEL_LABELS[level]} » sur ${a?.name || app}. Demandez au gérant (Paramètres → Utilisateurs).` });
    }
  }
  next();
}

// ---------- Invitations (partager un accès) ----------
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
export function createInvite(userId, days = 7) {
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + days * 864e5).toISOString();
  run('UPDATE users SET invite_hash=?, invite_expires=? WHERE id=?', sha(token), expires, userId);
  return { token, expires };
}
export function findInvite(token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return null;
  const u = get('SELECT * FROM users WHERE invite_hash=? AND active=1', sha(token));
  if (!u || !u.invite_expires || u.invite_expires < new Date().toISOString()) return null;
  return u;
}
export function clearInvite(userId) { run('UPDATE users SET invite_hash=NULL, invite_expires=NULL WHERE id=?', userId); }
