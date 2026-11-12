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
// Routes accessibles à tout utilisateur connecté (lecture de son propre pointage, notes du journal…)
const OPEN = [/^\/attendance\/me$/, /^\/attendance\/check$/, /^\/copilot\/journal/];
// Composer ou prévisualiser un e-mail ne demande pas l'application E-mails (mais bien le droit de lire la fiche liée)
const MAIL_OPEN = /^\/mail\/(compose|preview)$/;
const MAIL_RECORD = /^\/mail\/(compose|preview|send|draft-ai)$/;
const READ_POSTS = [/^\/website\/preview$/, /^\/mail\/preview$/, /^\/documents\/\d+\/qr\.svg$/];
// Suppressions courantes (annuler son e-mail programmé, effacer une conversation IA, retirer une pièce jointe) :
// le niveau « Utilisateur » suffit ; les autres suppressions restent réservées aux administrateurs de l'application.
const USER_DELETES = [/^\/mail\/\d+$/, /^\/agent-conversations\//, /^\/agent-tasks\/\d+$/, /^\/agent-results\/\d+$/, /^\/agents\/[^/]+\/messages$/, /^\/attachment\/\d+$/];

const typeApp = (t) => (t === 'order' ? 'atelier' : 'ventes');
/** Types de documents demandés dans l'adresse (?type=order,quote ou ?type=order&type=quote). */
export const queryList = (v) => [].concat(v ?? []).map(String).join(',').split(',').map((x) => x.trim()).filter(Boolean);

/** Application qui protège une fiche : ses pièces jointes, son historique, ses activités et ses e-mails suivent ce droit. */
export function recordApp(model, id) {
  switch (model) {
    case 'document': return typeApp(get('SELECT type FROM documents WHERE id=?', Number(id) || 0)?.type);
    case 'customer': case 'supplier': return 'contacts';
    case 'vehicle': return 'vehicules';
    case 'product': return 'inventaire';
    case 'purchase': return 'achats';
    case 'appointment': return 'atelier';
    case 'lead': return 'crm';
    default: return null;
  }
}

// Applications à contrôler pour une route /documents (une liste [a, b] signifie « l'une des deux »)
function documentApps(req, path, read) {
  const m = /^\/documents\/(\d+)/.exec(path);
  if (m) return [typeApp(get('SELECT type FROM documents WHERE id=?', Number(m[1]))?.type)];
  if (!read) return [typeApp(req.body?.type)];
  const types = queryList(req.query.type);
  // Sans type : la liste est filtrée ensuite selon les droits (voir GET /documents)
  return types.length ? [...new Set(types.map(typeApp))] : [['ventes', 'atelier']];
}

/**
 * Droits nécessaires pour une requête : liste de [application, niveau] à satisfaire TOUS.
 * « application » peut être une liste : l'une d'elles suffit.
 */
export function requiredAccess(req) {
  // Les adresses sont comparées en minuscules et sans « / » final (Express les accepte aussi)
  const path = req.path.toLowerCase().replace(/\/+$/, '') || '/';
  const read = req.method === 'GET' || req.method === 'HEAD';
  if (OPEN.some((r) => r.test(path))) return null;
  if (read && path === '/mail/config') return null; // sans secret : sert aux activités de tout le monde
  let m;
  // Pièces jointes et historique : mêmes droits que la fiche à laquelle ils sont attachés
  if ((m = /^\/(attachments|chatter)\/([a-z_]+)\/(\d+)/.exec(path))) {
    const app = recordApp(m[2], m[3]);
    return app ? [[app, read ? 'read' : 'user']] : null;
  }
  if ((m = /^\/attachment\/(\d+)$/.exec(path))) {
    const a = get('SELECT model, record_id FROM attachments WHERE id=?', Number(m[1]));
    const app = a && recordApp(a.model, a.record_id);
    return app ? [[app, read ? 'read' : 'user']] : null;
  }
  // Planifier une activité sur une fiche : il faut pouvoir lire cette fiche
  if (path === '/activities' && req.method === 'POST') {
    const app = recordApp(req.body?.model, req.body?.record_id);
    return app ? [[app, 'read']] : null;
  }
  // Le plan comptable (simple liste de comptes) sert aussi aux achats et aux fiches fournisseurs
  if (read && path === '/accounting/accounts') return [[['comptabilite', 'achats', 'contacts'], 'read']];

  const need = [];
  const hit = PREFIXES.find(([p]) => (p.endsWith('-') ? path.startsWith(p) : path === p || path.startsWith(p + '/')));
  if (hit && !MAIL_OPEN.test(path)) {
    const level = read || READ_POSTS.some((r) => r.test(path)) ? 'read' : req.method === 'DELETE' && !USER_DELETES.some((r) => r.test(path)) ? 'manager' : 'user';
    for (const app of hit[1] ? [hit[1]] : documentApps(req, path, read)) need.push([app, level]);
  }
  // E-mail lié à une fiche (facture, relevé client…) : il faut pouvoir lire cette fiche
  if (MAIL_RECORD.test(path)) {
    const app = read ? recordApp(req.query.model, req.query.id) : recordApp(req.body?.model, req.body?.record_id);
    if (app) need.push([app, 'read']);
  }
  // Convertir un OR en facture (ou un devis en OR) demande aussi les droits sur l'application cible
  if (/^\/documents\/\d+\/convert$/.test(path) && req.body?.type) need.push([typeApp(req.body.type), 'user']);
  // Encaisser une facture client ou payer une facture fournisseur touche à la banque
  if (/^\/(documents|purchases)\/\d+\/payments$/.test(path)) need.push(['banque', 'user']);
  // « Commander le stock bas » crée des commandes fournisseurs
  if (path === '/stock/reorder') need.push(['achats', 'user']);
  return need.length ? need : null;
}

/** Middleware : refuse l'accès si l'utilisateur n'a pas le niveau requis sur l'application. */
export function accessGuard(req, res, next) {
  const u = req.user;
  if (!u) return next();
  if (u.session_kind === 'kiosk' && !req.path.toLowerCase().startsWith('/kiosk')) return res.status(403).json({ error: 'Session kiosque : accès limité au pointage' });
  if (u.role === 'admin') return next();
  const need = requiredAccess(req);
  if (!need) return next();
  for (const [app, level] of need) {
    const apps = [].concat(app);
    if (!apps.some((a) => can(u, a, level))) {
      const names = apps.map((a) => APPS.find((x) => x.key === a)?.name || a).join(' ou ');
      return res.status(403).json({ error: `Accès refusé : il faut le droit « ${LEVEL_LABELS[level]} » sur ${names}. Demandez au gérant (Paramètres → Utilisateurs).` });
    }
  }
  next();
}

/** Tableau de bord : chaque chiffre n'est montré qu'à ceux qui ont l'application correspondante (écran d'accueil, agents IA). */
export function maskDashboard(d, u) {
  if (!u || u.role === 'admin') return d;
  if (!can(u, 'ventes')) Object.assign(d, { salesMonth: null, salesYear: null, receivable: null, overdue: null, quotesPending: null, monthly: [] });
  if (!can(u, 'banque')) Object.assign(d, { bank: null, unmatchedBank: null });
  if (!can(u, 'achats')) d.payable = null;
  if (!can(u, 'inventaire')) d.lowStock = [];
  if (!can(u, 'atelier')) Object.assign(d, { ordersOpen: null, appointmentsToday: [] });
  if (!can(u, 'vehicules')) d.inspectionsSoon = [];
  if (!can(u, 'presences')) d.present = [];
  return d;
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
