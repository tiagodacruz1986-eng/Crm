// Logos des marques de véhicules (parc automobile, ordres de réparation, atelier, tablette).
// Le logiciel ne fournit aucun logo : ce sont des marques déposées. Ils viennent d'Odoo (Parc automobile → marques,
// repris en un clic) ou sont ajoutés à la main par le garage. Ils sont rangés dans le dossier des données (data/brands).
import fs from 'node:fs';
import path from 'node:path';
import { db, all, get, run, dataDir, localDateTime } from './db.js';
import { BusinessError } from './business.js';

const DIR = path.join(dataDir, 'brands');
db.exec(`CREATE TABLE IF NOT EXISTS vehicle_brands (
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, ext TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'upload', updated_at TEXT
)`);

const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const MAX_BYTES = 1024 * 1024;

// Type réel du fichier d'après sa signature (pas de SVG : il pourrait contenir du script)
function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Autres façons d'écrire une même marque (après mise en minuscules, sans accents ni espaces). */
export const ALIASES = {
  vw: 'volkswagen', volkswagenvw: 'volkswagen', mercedesbenz: 'mercedes', mercedesamg: 'mercedes', mb: 'mercedes',
  teslamotors: 'tesla', alfa: 'alfaromeo', rangerover: 'landrover', minicooper: 'mini', bmwmotorrad: 'bmw',
  ds: 'dsautomobiles', citroends: 'dsautomobiles', rolls: 'rollsroyce', vauxhallopel: 'opel', seatcupra: 'cupra',
  chevroletdaewoo: 'chevrolet', lynk: 'lynkco', lynkandco: 'lynkco',
};
/** « Mercedes-Benz », « MERCEDES », « mercedes benz » → « mercedes ». */
export function brandSlug(make) {
  const s = String(make ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ALIASES[s] || s;
}

/** Ce dont l'interface a besoin pour afficher les logos : les variantes d'écriture et les marques qui ont une image. */
export function brandIndex() {
  const logos = {};
  for (const b of all('SELECT slug, name, updated_at FROM vehicle_brands')) logos[b.slug] = { name: b.name, v: (b.updated_at || '').replace(/\D/g, '') };
  return { aliases: ALIASES, logos };
}

/** Fichier du logo d'une marque, ou null. */
export function brandFile(slug) {
  const s = brandSlug(slug);
  const b = s && get('SELECT ext FROM vehicle_brands WHERE slug=?', s);
  if (!b || !TYPES[b.ext]) return null;
  const file = path.join(DIR, `${s}.${b.ext}`);
  return fs.existsSync(file) ? { file, type: TYPES[b.ext] } : null;
}

/** Enregistre (ou remplace) le logo d'une marque. source : 'upload' (ajouté à la main) ou 'odoo'. */
export function saveBrandLogo(name, buf, source = 'upload') {
  const label = String(name ?? '').trim().slice(0, 60);
  const slug = brandSlug(label);
  if (!slug) throw new BusinessError('Indiquez le nom de la marque');
  if (!Buffer.isBuffer(buf) || !buf.length) throw new BusinessError('Fichier vide');
  if (buf.length > MAX_BYTES) throw new BusinessError('Logo trop lourd (1 Mo maximum)');
  const ext = sniff(buf);
  if (!ext) throw new BusinessError('Format non pris en charge : utilisez une image PNG, JPEG ou WebP');
  fs.mkdirSync(DIR, { recursive: true });
  for (const e of Object.keys(TYPES)) fs.rmSync(path.join(DIR, `${slug}.${e}`), { force: true });
  fs.writeFileSync(path.join(DIR, `${slug}.${ext}`), buf);
  run(`INSERT INTO vehicle_brands(slug, name, ext, source, updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET name=excluded.name, ext=excluded.ext, source=excluded.source, updated_at=excluded.updated_at`, slug, label, ext, source === 'odoo' ? 'odoo' : 'upload', localDateTime());
  return { slug, name: label };
}

export function deleteBrandLogo(slug) {
  const s = brandSlug(slug);
  if (!get('SELECT 1 FROM vehicle_brands WHERE slug=?', s)) throw new BusinessError('Cette marque n\'a pas de logo', 404);
  for (const e of Object.keys(TYPES)) fs.rmSync(path.join(DIR, `${s}.${e}`), { force: true });
  run('DELETE FROM vehicle_brands WHERE slug=?', s);
  return { ok: true };
}

/** Liste pour la fenêtre « Logos des marques » : les marques des véhicules du garage, puis les autres logos enregistrés. */
export function listBrands() {
  const logos = new Map(all('SELECT slug, name, source, updated_at FROM vehicle_brands').map((b) => [b.slug, b]));
  const out = new Map();
  for (const r of all("SELECT make, COUNT(*) AS n FROM vehicles WHERE make IS NOT NULL AND TRIM(make) != '' GROUP BY make")) {
    const slug = brandSlug(r.make);
    if (!slug) continue;
    const cur = out.get(slug);
    // plusieurs écritures de la même marque (« VW », « Volkswagen ») : une seule ligne, le nom le plus fréquent
    if (cur) { cur.vehicles += r.n; if (r.n > cur.top) { cur.top = r.n; cur.name = r.make.trim(); } } else out.set(slug, { slug, name: r.make.trim(), vehicles: r.n, top: r.n });
  }
  for (const [slug, b] of logos) if (!out.has(slug)) out.set(slug, { slug, name: b.name, vehicles: 0, top: 0 });
  return [...out.values()].map(({ top, ...b }) => ({ ...b, logo: logos.has(b.slug), source: logos.get(b.slug)?.source || null, v: (logos.get(b.slug)?.updated_at || '').replace(/\D/g, '') }))
    .sort((a, b) => b.vehicles - a.vehicles || a.name.localeCompare(b.name, 'fr'));
}
