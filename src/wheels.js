// Gardiennage des roues (Parc automobile) : pour chaque véhicule, un jeu « été » et un jeu « hiver » — marque et
// dimension des pneus, pneus à remplacer (avant / arrière), date de mise en gardiennage, emplacement, une photo par
// roue. Le mécanicien remplit la fiche sur la tablette de l'atelier (depuis l'OR), le bureau depuis la fiche du
// véhicule. Quand un contrôle signale des pneus à remplacer pour la saison prochaine, un rappel « devis à faire » est
// créé pour le gérant dans les activités : il ne dépend pas de la mémoire de quelqu'un.
import { db, all, get, run, insert, update, tx, today, isDate, localDateTime } from './db.js';
import { BusinessError } from './business.js';
import { saveAttachment, attachmentFile, deleteAttachment } from './bills.js';
import { createActivity, logMessage } from './mail.js';

db.exec(`
CREATE TABLE IF NOT EXISTS wheel_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vehicle_id INTEGER NOT NULL, season TEXT NOT NULL,
  brand TEXT, size TEXT, replace_front INTEGER DEFAULT 0, replace_rear INTEGER DEFAULT 0,
  stored_at TEXT, location TEXT, notes TEXT,
  quote_activity_id INTEGER, quote_key TEXT, checked_by INTEGER, checked_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(vehicle_id, season)
);
`);

export const SEASONS = { summer: 'été', winter: 'hiver' };
export const POSITIONS = { fl: 'avant gauche', fr: 'avant droite', rl: 'arrière gauche', rr: 'arrière droite' };
const MODEL = 'wheelset'; // pièces jointes : une photo par roue, la position est gardée dans « source »
const PHOTO_MAX = 12 * 1024 * 1024;
const COLS = ['brand', 'size', 'replace_front', 'replace_rear', 'stored_at', 'location', 'notes'];

const season = (s) => { if (!Object.hasOwn(SEASONS, s)) throw new BusinessError('Saison inconnue (été ou hiver)'); return s; };
const position = (p) => { if (!Object.hasOwn(POSITIONS, p)) throw new BusinessError('Roue inconnue'); return p; };
const vehicle = (id) => {
  const v = get('SELECT v.id, v.plate, v.make, v.model, v.tyre_size, v.customer_id, c.name AS customer_name FROM vehicles v LEFT JOIN customers c ON c.id=v.customer_id WHERE v.id=?', Number(id) || 0);
  if (!v) throw new BusinessError('Véhicule introuvable', 404);
  return v;
};
const firstAdmin = () => get("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1")?.id || null;
const userName = (id) => (id ? get('SELECT name FROM users WHERE id=?', id)?.name : null) || null;
const fr = (d) => (isDate(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
/** « avant », « arrière », « avant et arrière » — ou rien. */
export const replaceLabel = (s) => (s.replace_front && s.replace_rear ? 'avant et arrière' : s.replace_front ? 'avant' : s.replace_rear ? 'arrière' : '');

function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const BLANK = { id: null, brand: null, size: null, replace_front: 0, replace_rear: 0, stored_at: null, location: null, notes: null, checked_at: null, checked_by_name: null, photos: {}, quote: null };
function present(s) {
  if (!s) return { ...BLANK, photos: {} };
  const photos = {};
  for (const a of all('SELECT id, source, created_at FROM attachments WHERE model=? AND record_id=? ORDER BY id', MODEL, s.id)) if (Object.hasOwn(POSITIONS, a.source)) photos[a.source] = { id: a.id, at: a.created_at };
  const q = s.quote_activity_id ? get('SELECT id, status, due_date, user_id FROM activities WHERE id=?', s.quote_activity_id) : null;
  return {
    id: s.id, brand: s.brand, size: s.size, replace_front: s.replace_front ? 1 : 0, replace_rear: s.replace_rear ? 1 : 0, stored_at: s.stored_at, location: s.location, notes: s.notes,
    checked_at: s.checked_at, checked_by_name: userName(s.checked_by), photos,
    quote: q ? { id: q.id, status: q.status, due_date: q.due_date, user_name: userName(q.user_id) } : null,
  };
}
const row = (vehicleId, s) => get('SELECT * FROM wheel_sets WHERE vehicle_id=? AND season=?', vehicleId, s);

/** Les deux jeux de roues d'un véhicule (un jeu jamais rempli revient vide). */
export function getWheels(vehicleId) {
  const v = vehicle(vehicleId);
  return { vehicle: v, summer: present(row(v.id, 'summer')), winter: present(row(v.id, 'winter')) };
}

/**
 * Rappel « devis à faire » : créé quand des pneus sont signalés à remplacer, pour le gérant, à faire le jour même.
 * Un seul rappel par constat : tant qu'il est en attente il suit les corrections ; une fois traité, il n'est recréé
 * que si le constat change — d'autres pneus, ou une NOUVELLE date de gardiennage (la saison suivante). Compléter la
 * date après coup, ou la vider quand les roues repartent sur le véhicule, n'est pas un nouveau constat.
 * Plus rien à remplacer : le rappel en attente est annulé.
 */
function syncQuote(setId, userId) {
  const s = get('SELECT * FROM wheel_sets WHERE id=?', setId);
  if (!s) return;
  const act = s.quote_activity_id ? get('SELECT id, status FROM activities WHERE id=?', s.quote_activity_id) : null;
  const what = replaceLabel(s);
  if (!what) {
    if (act?.status === 'planned') run("UPDATE activities SET status='cancelled' WHERE id=?", act.id);
    run('UPDATE wheel_sets SET quote_activity_id=NULL, quote_key=NULL WHERE id=?', s.id);
    return;
  }
  const v = vehicle(s.vehicle_id);
  const [oldFlags, oldDate = ''] = (s.quote_key || '').split('|');
  const flags = `${s.replace_front ? 'f' : ''}${s.replace_rear ? 'r' : ''}`;
  const key = `${flags}|${s.stored_at || oldDate}`;
  const changed = s.quote_key == null || flags !== oldFlags || Boolean(oldDate && s.stored_at && s.stored_at !== oldDate);
  // (le nom de celui qui a fait le constat reste, même si quelqu'un d'autre complète la fiche ensuite)
  const kept = act?.status === 'planned' && flags === oldFlags ? (get('SELECT note FROM activities WHERE id=?', act.id)?.note || '').match(/^Constat de .*$/m)?.[0] : null;
  const car = [v.plate, v.make, v.model].filter(Boolean).join(' ') || 'véhicule';
  const summary = `Devis pneus à faire : ${car} — pneus ${SEASONS[s.season]} ${what} à remplacer pour la saison prochaine`.slice(0, 250);
  const note = [v.customer_name && `Client : ${v.customer_name}`, s.brand && `Marque : ${s.brand}`, s.size && `Dimension : ${s.size}`, s.stored_at && `En gardiennage depuis le ${fr(s.stored_at)}`,
    s.notes && `Remarque : ${s.notes}`, kept || (userName(userId) && `Constat de ${userName(userId)}, le ${fr(today())}.`), 'Ouvrez la fiche du véhicule pour voir les photos des roues et créer le devis.'].filter(Boolean).join('\n');
  if (act?.status === 'planned') run('UPDATE activities SET summary=?, note=? WHERE id=?', summary, note, act.id);
  else if (!act || changed) {
    const owner = firstAdmin();
    if (!owner) return;
    const id = createActivity({ model: 'vehicle', record_id: v.id, type: 'todo', summary, note, due_date: today(), user_id: owner }, userId || owner);
    run('UPDATE wheel_sets SET quote_activity_id=? WHERE id=?', id, s.id);
  }
  run('UPDATE wheel_sets SET quote_key=? WHERE id=?', key, s.id);
}

const text = (v, label, max) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new BusinessError(`${label} : texte attendu`);
  return v.replace(/\s+/g, ' ').trim().slice(0, max) || null;
};
const flag = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

/** Enregistre la fiche d'un jeu de roues (seuls les champs envoyés changent) et met le rappel de devis à jour. */
export function saveWheels(vehicleId, seasonKey, body = {}, userId = null) {
  const v = vehicle(vehicleId);
  const s = season(seasonKey);
  const data = {};
  if (body.brand !== undefined) data.brand = text(body.brand, 'Marque', 80);
  if (body.size !== undefined) data.size = text(body.size, 'Dimension', 80);
  if (body.location !== undefined) data.location = text(body.location, 'Emplacement', 80);
  if (body.notes !== undefined) { if (body.notes !== null && typeof body.notes !== 'string') throw new BusinessError('Remarque : texte attendu'); data.notes = (body.notes || '').trim().slice(0, 1000) || null; }
  if (body.replace_front !== undefined) data.replace_front = flag(body.replace_front);
  if (body.replace_rear !== undefined) data.replace_rear = flag(body.replace_rear);
  if (body.stored_at !== undefined) {
    if (body.stored_at === null || body.stored_at === '') data.stored_at = null;
    else if (!isDate(body.stored_at)) throw new BusinessError('Date du gardiennage : date invalide');
    else data.stored_at = body.stored_at;
  }
  tx(() => {
    const cur = row(v.id, s);
    const before = cur ? replaceLabel(cur) : '';
    const stamp = { ...data, checked_by: userId, checked_at: localDateTime() };
    let id = cur?.id;
    if (cur) update('wheel_sets', cur.id, stamp, [...COLS, 'checked_by', 'checked_at']);
    else id = insert('wheel_sets', { vehicle_id: v.id, season: s, ...stamp }, ['vehicle_id', 'season', ...COLS, 'checked_by', 'checked_at']);
    const now = get('SELECT * FROM wheel_sets WHERE id=?', id);
    const after = replaceLabel(now);
    // une ligne dans l'historique du véhicule quand le constat change (pas à chaque enregistrement)
    if (after !== before) logMessage('vehicle', v.id, after ? `🛞 Roues ${SEASONS[s]} : pneus ${after} à remplacer pour la saison prochaine` : `🛞 Roues ${SEASONS[s]} : plus de pneus à remplacer`, userId, 'system');
    else if (!cur?.stored_at && now.stored_at) logMessage('vehicle', v.id, `🛞 Roues ${SEASONS[s]} mises en gardiennage le ${fr(now.stored_at)}${now.location ? ` (${now.location})` : ''}`, userId, 'system');
    syncQuote(id, userId);
  });
  return getWheels(v.id);
}

/** Photo d'une roue : une seule par roue, la nouvelle remplace l'ancienne. */
export function savePhoto(vehicleId, seasonKey, pos, { buffer, filename } = {}, userId = null) {
  const v = vehicle(vehicleId);
  const s = season(seasonKey);
  const p = position(pos);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new BusinessError('Photo vide');
  if (buffer.length > PHOTO_MAX) throw new BusinessError('Photo trop lourde (12 Mo au plus)');
  const mime = imageType(buffer);
  if (!mime) throw new BusinessError('Ce fichier n\'est pas une photo (JPEG, PNG ou WebP)');
  tx(() => {
    let cur = row(v.id, s);
    if (!cur) cur = { id: insert('wheel_sets', { vehicle_id: v.id, season: s, checked_by: userId, checked_at: localDateTime() }, ['vehicle_id', 'season', 'checked_by', 'checked_at']) };
    const old = all('SELECT id FROM attachments WHERE model=? AND record_id=? AND source=?', MODEL, cur.id, p);
    saveAttachment(MODEL, cur.id, { buffer, mime, filename: `roue-${s === 'summer' ? 'ete' : 'hiver'}-${p}.${mime.split('/')[1].replace('jpeg', 'jpg')}`, source: p });
    for (const a of old) deleteAttachment(a.id);
  });
  return getWheels(v.id);
}

export function deletePhoto(vehicleId, seasonKey, pos) {
  const v = vehicle(vehicleId);
  const cur = row(v.id, season(seasonKey));
  const p = position(pos);
  if (cur) for (const a of all('SELECT id FROM attachments WHERE model=? AND record_id=? AND source=?', MODEL, cur.id, p)) deleteAttachment(a.id);
  return getWheels(v.id);
}

/** Fichier d'une photo de roue de CE véhicule (pour la tablette de l'atelier, qui n'a pas accès aux autres pièces jointes). */
export function photoFile(vehicleId, attachmentId) {
  const a = attachmentFile(Number(attachmentId) || 0);
  if (!a || a.model !== MODEL || !get('SELECT 1 FROM wheel_sets WHERE id=? AND vehicle_id=?', a.record_id, Number(vehicleId) || 0)) return null;
  return a;
}

/** Vue d'ensemble : tous les jeux de roues renseignés, ceux à remplacer d'abord, puis les plus anciens en gardiennage. */
export function listWheels({ filter = '' } = {}) {
  const where = filter === 'replace' ? '(w.replace_front=1 OR w.replace_rear=1)' : filter === 'stored' ? 'w.stored_at IS NOT NULL'
    : "(w.stored_at IS NOT NULL OR w.replace_front=1 OR w.replace_rear=1 OR IFNULL(w.brand,'')!='' OR IFNULL(w.size,'')!='' OR EXISTS (SELECT 1 FROM attachments a WHERE a.model='wheelset' AND a.record_id=w.id))";
  return all(`SELECT w.id, w.vehicle_id, w.season, w.brand, w.size, w.replace_front, w.replace_rear, w.stored_at, w.location, w.checked_at,
      v.plate, v.make, v.model, v.customer_id, c.name AS customer_name, a.status AS quote_status,
      (SELECT COUNT(*) FROM attachments x WHERE x.model='wheelset' AND x.record_id=w.id) AS photo_count
    FROM wheel_sets w JOIN vehicles v ON v.id=w.vehicle_id LEFT JOIN customers c ON c.id=v.customer_id LEFT JOIN activities a ON a.id=w.quote_activity_id
    WHERE ${where} ORDER BY (w.replace_front=1 OR w.replace_rear=1) DESC, w.stored_at IS NULL, w.stored_at, v.plate LIMIT 1000`);
}

/** Véhicule supprimé : ses jeux de roues et leurs photos partent avec lui. */
export function forgetVehicle(vehicleId) {
  for (const s of all('SELECT id FROM wheel_sets WHERE vehicle_id=?', Number(vehicleId) || 0)) {
    for (const a of all('SELECT id FROM attachments WHERE model=? AND record_id=?', MODEL, s.id)) deleteAttachment(a.id);
    run('DELETE FROM wheel_sets WHERE id=?', s.id);
  }
}
