import crypto from 'node:crypto';
import { get, run } from './db.js';

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(secret), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
export function verifySecret(secret, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(secret), salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

export function createSession(userId, kind = 'web') {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token,user_id,kind) VALUES(?,?,?)', token, userId, kind);
  return token;
}

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const m = /(?:^|;\s*)gsession=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

export function currentUser(req) {
  const token = readToken(req);
  if (!token) return null;
  const u = get(
    `SELECT u.id,u.name,u.email,u.role,u.color,s.kind AS session_kind FROM sessions s
     JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1`,
    token
  );
  return u ? { ...u, token } : null;
}

// Les mécaniciens (session "kiosk") n'accèdent qu'aux routes /api/kiosk
export function requireAuth(roles = ['admin', 'office']) {
  return (req, res, next) => {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ error: 'Non connecté' });
    if (roles && !roles.includes(u.role)) return res.status(403).json({ error: 'Accès refusé' });
    req.user = u;
    next();
  };
}
