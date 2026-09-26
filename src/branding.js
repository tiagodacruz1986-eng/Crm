// Logo du garage et mise en page des documents imprimés.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, getSettings, setSetting } from './db.js';

const DIR = path.join(dataDir, 'branding');
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
export const TEMPLATES = ['moderne', 'encadre', 'audacieux', 'raye', 'classique', 'atelier'];
export const FONTS = ['inter', 'grotesk', 'arial', 'georgia', 'palatino'];
const HEX = /^#[0-9a-f]{6}$/i;

// Type réel du fichier d'après sa signature (pas d'SVG : il pourrait contenir du script)
function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function logoFile(name = 'logo') {
  for (const ext of Object.keys(TYPES)) {
    const f = path.join(DIR, name + '.' + ext);
    if (fs.existsSync(f)) return { file: f, type: TYPES[ext], ext };
  }
  return null;
}

export function saveLogo(buf) {
  if (!buf?.length) throw Object.assign(new Error('Fichier vide'), { status: 400 });
  if (buf.length > 3 * 1024 * 1024) throw Object.assign(new Error('Logo trop lourd (3 Mo maximum)'), { status: 400 });
  const ext = sniff(buf);
  if (!ext) throw Object.assign(new Error('Format non pris en charge : utilisez un PNG, JPEG ou WebP'), { status: 400 });
  fs.mkdirSync(DIR, { recursive: true });
  removeLogoFiles();
  fs.writeFileSync(path.join(DIR, 'logo.' + ext), buf);
  const layout = { ...getSettings().layout, logo_version: Date.now() };
  setSetting('layout', layout);
  return layout;
}

function removeLogoFiles() {
  for (const ext of Object.keys(TYPES)) fs.rmSync(path.join(DIR, 'logo.' + ext), { force: true });
}

export function deleteLogo() {
  removeLogoFiles();
  const layout = { ...getSettings().layout, logo_version: null };
  setSetting('layout', layout);
  return layout;
}

/** Nettoie la mise en page envoyée par le navigateur (valeurs connues uniquement). */
export function cleanLayout(input = {}) {
  const cur = getSettings().layout;
  const out = { ...cur };
  if (TEMPLATES.includes(input.template)) out.template = input.template;
  if (FONTS.includes(input.font)) out.font = input.font;
  for (const k of ['primary', 'secondary']) if (HEX.test(input[k] || '')) out[k] = input[k].toLowerCase();
  if (['A4', 'Letter'].includes(input.paper)) out.paper = input.paper;
  if (['s', 'm', 'l'].includes(input.logo_size)) out.logo_size = input.logo_size;
  for (const [k, max] of [['tagline', 120], ['header_note', 300], ['terms', 6000]]) if (typeof input[k] === 'string') out[k] = input[k].slice(0, max);
  for (const k of ['show_logo', 'show_qr', 'show_bank', 'show_vehicle', 'show_signature', 'show_paid_stamp', 'show_discount']) if (k in input) out[k] = Boolean(input[k]);
  out.logo_version = cur.logo_version; // géré uniquement par l'envoi du logo
  return out;
}

// Fond d'écran du menu d'accueil des applications (comme Odoo)
export function saveBackground(buf) {
  if (!buf?.length) throw Object.assign(new Error('Fichier vide'), { status: 400 });
  if (buf.length > 8 * 1024 * 1024) throw Object.assign(new Error('Image trop lourde (8 Mo maximum)'), { status: 400 });
  const ext = sniff(buf);
  if (!ext) throw Object.assign(new Error('Format non pris en charge : utilisez un PNG, JPEG ou WebP'), { status: 400 });
  fs.mkdirSync(DIR, { recursive: true });
  for (const e of Object.keys(TYPES)) fs.rmSync(path.join(DIR, 'home.' + e), { force: true });
  fs.writeFileSync(path.join(DIR, 'home.' + ext), buf);
  const home = { ...(getSettings().home || {}), background_version: Date.now() };
  setSetting('home', home);
  return home;
}
export function deleteBackground() {
  for (const e of Object.keys(TYPES)) fs.rmSync(path.join(DIR, 'home.' + e), { force: true });
  const home = { ...(getSettings().home || {}), background_version: null };
  setSetting('home', home);
  return home;
}
export const sniffImage = sniff;
