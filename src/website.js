// Site web du garage (inspiré de l'application Site web d'Odoo) : blocs modifiables, publication,
// formulaire de contact / demande de rendez-vous qui crée une opportunité dans le CRM.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { dataDir, getSettings, setSetting, all, get } from './db.js';
import { aiConfigured, claudeClient, CLAUDE_MODEL } from './claude.js';
import { saveLead, SOURCES } from './crm.js';
import { createActivity } from './mail.js';
import { sniffImage } from './branding.js';

const MEDIA = path.join(dataDir, 'website');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl2br = (s) => esc(s).replace(/\n/g, '<br>');
const safeUrl = (u) => (/^\/site-media\/[a-f0-9]{24}\.(png|jpg|webp)$/.test(u || '') || /^https:\/\/[^\s"'<>]+$/.test(u || '') ? u : '');
const HEX = /^#[0-9a-f]{6}$/i;

export const BLOCK_TYPES = {
  hero: 'Bannière d\'accueil', services: 'Nos services', promo: 'Offre du moment', about: 'À propos', reviews: 'Avis clients',
  gallery: 'Galerie photos', faq: 'Questions fréquentes', hours: 'Horaires & accès', contact: 'Contact & rendez-vous',
};
const uid = () => crypto.randomBytes(4).toString('hex');

/** Site de départ construit à partir des informations du garage (sans IA). */
export function defaultBlocks() {
  const c = getSettings().company;
  const city = c.city || 'Luxembourg';
  return [
    { id: uid(), type: 'hero', title: `${c.name}, votre garage à ${city}`, subtitle: 'Entretien, réparation, pneus et diagnostic toutes marques. Devis rapide, suivi en temps réel de votre véhicule.', cta_label: 'Prendre rendez-vous', image: '' },
    { id: uid(), type: 'services', title: 'Nos services', items: [
      { icon: '🛠️', name: 'Entretien & vidange', text: 'Entretien constructeur sans perdre la garantie.', price: '' },
      { icon: '🛞', name: 'Pneus & géométrie', text: 'Montage, équilibrage, stockage de vos pneus hiver.', price: '' },
      { icon: '🛑', name: 'Freinage', text: 'Plaquettes, disques, liquide de frein.', price: '' },
      { icon: '🔌', name: 'Diagnostic électronique', text: 'Voyant allumé ? Diagnostic précis toutes marques.', price: '' },
      { icon: '❄️', name: 'Climatisation', text: 'Recharge et contrôle d\'étanchéité.', price: '' },
      { icon: '✅', name: 'Préparation au contrôle technique', text: 'On vérifie tout avant votre passage.', price: '' },
    ] },
    { id: uid(), type: 'promo', hidden: true, badge: 'Offre du moment', title: 'Passage aux pneus hiver', text: 'Décrivez ici votre offre du moment (elle reste masquée tant que vous ne l\'affichez pas).' },
    { id: uid(), type: 'about', title: 'Un garage de confiance', text: `Chez ${c.name}, chaque réparation est expliquée et chiffrée avant d'être réalisée. Vous recevez des photos de l'atelier et suivez l'avancement de votre véhicule en direct sur votre téléphone.`, image: '' },
    // Masqué tant que de vrais avis (Google, Facebook…) n'ont pas été recopiés : on ne publie jamais de faux avis
    { id: uid(), type: 'reviews', hidden: true, title: 'Ils nous font confiance', items: [
      { name: 'Prénom du client', text: 'Recopiez ici un vrai avis de votre fiche Google ou Facebook.', stars: 5 },
    ] },
    { id: uid(), type: 'faq', title: 'Questions fréquentes', items: [
      { q: 'Faut-il prendre rendez-vous ?', a: 'Oui, c\'est plus rapide : utilisez le formulaire ci-dessous ou appelez-nous.' },
      { q: 'Travaillez-vous sur toutes les marques ?', a: 'Oui, y compris les véhicules hybrides et électriques.' },
    ] },
    { id: uid(), type: 'hours', title: 'Horaires & accès' },
    { id: uid(), type: 'contact', title: 'Demande de rendez-vous ou de devis', text: 'Laissez-nous vos coordonnées, nous vous recontactons rapidement.' },
  ];
}

export function websiteConfig() {
  const w = getSettings().website || {};
  return { published: false, theme: 'dark', accent: '', seo_title: '', seo_description: '', blocks: null, ...w, blocks: Array.isArray(w.blocks) ? w.blocks : defaultBlocks() };
}

// Nettoyage des blocs envoyés par l'éditeur
const str = (v, n = 400) => String(v ?? '').slice(0, n);
function cleanBlock(b) {
  if (!b || !BLOCK_TYPES[b.type]) return null;
  const o = { id: /^[a-z0-9]{4,16}$/.test(b.id || '') ? b.id : uid(), type: b.type, hidden: Boolean(b.hidden), title: str(b.title, 160) };
  if (['hero', 'about', 'promo', 'contact'].includes(b.type)) { o.text = str(b.text, 1500); o.subtitle = str(b.subtitle, 400); o.cta_label = str(b.cta_label, 60); o.badge = str(b.badge, 40); o.image = safeUrl(b.image); }
  if (b.type === 'services') o.items = (b.items || []).slice(0, 12).map((i) => ({ icon: str(i.icon, 8), name: str(i.name, 80), text: str(i.text, 300), price: str(i.price, 40) }));
  if (b.type === 'reviews') o.items = (b.items || []).slice(0, 12).map((i) => ({ name: str(i.name, 60), text: str(i.text, 500), stars: Math.min(5, Math.max(1, Number(i.stars) || 5)) }));
  if (b.type === 'faq') o.items = (b.items || []).slice(0, 15).map((i) => ({ q: str(i.q, 200), a: str(i.a, 800) }));
  if (b.type === 'gallery') o.images = (b.images || []).map(safeUrl).filter(Boolean).slice(0, 16);
  return o;
}
export function saveWebsite(input = {}) {
  const cur = websiteConfig();
  const out = {
    published: 'published' in input ? Boolean(input.published) : cur.published,
    theme: ['dark', 'light'].includes(input.theme) ? input.theme : cur.theme,
    accent: HEX.test(input.accent || '') ? input.accent : input.accent === '' ? '' : cur.accent,
    seo_title: str(input.seo_title ?? cur.seo_title, 70), seo_description: str(input.seo_description ?? cur.seo_description, 160),
    blocks: Array.isArray(input.blocks) ? input.blocks.slice(0, 30).map(cleanBlock).filter(Boolean) : cur.blocks,
  };
  setSetting('website', out);
  return out;
}

// Images du site
export function saveSiteImage(buf) {
  if (!buf?.length) throw Object.assign(new Error('Fichier vide'), { status: 400 });
  if (buf.length > 8 * 1024 * 1024) throw Object.assign(new Error('Image trop lourde (8 Mo maximum)'), { status: 400 });
  const ext = sniffImage(buf);
  if (!ext) throw Object.assign(new Error('Format non pris en charge : PNG, JPEG ou WebP'), { status: 400 });
  fs.mkdirSync(MEDIA, { recursive: true });
  const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(MEDIA, name), buf);
  return { url: '/site-media/' + name };
}
export function siteMediaFile(name) {
  if (!/^[a-f0-9]{24}\.(png|jpg|webp)$/.test(name || '')) return null;
  const f = path.join(MEDIA, name);
  return fs.existsSync(f) ? f : null;
}

// ---------- Génération par l'IA ----------
const GEN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['hero_title', 'hero_subtitle', 'services', 'promo_title', 'promo_text', 'about_title', 'about_text', 'faq', 'seo_title', 'seo_description'],
  properties: {
    hero_title: { type: 'string' }, hero_subtitle: { type: 'string' },
    services: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['icon', 'name', 'text', 'price'], properties: { icon: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' }, price: { type: 'string' } } } },
    promo_title: { type: 'string' }, promo_text: { type: 'string' },
    about_title: { type: 'string' }, about_text: { type: 'string' },
    faq: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['q', 'a'], properties: { q: { type: 'string' }, a: { type: 'string' } } } },
    seo_title: { type: 'string' }, seo_description: { type: 'string' },
  },
};
export async function generateWebsite({ notes = '', tone = 'chaleureux et professionnel' } = {}) {
  const s = getSettings();
  const cfg = websiteConfig();
  if (!aiConfigured()) return { ai: false, config: saveWebsite({ ...cfg, blocks: defaultBlocks() }) };
  const services = all("SELECT name, sale_price FROM products WHERE active=1 AND (is_service=1 OR labor_hours>0) ORDER BY name LIMIT 25");
  const resp = await claudeClient().messages.parse({
    model: CLAUDE_MODEL, max_tokens: 16000,
    messages: [{
      role: 'user',
      content: `Rédige le contenu du site web d'un garage automobile au Luxembourg, en français, ton ${str(tone, 60)}.
Garage : ${s.company.name}, ${[s.company.address, s.company.zip, s.company.city].filter(Boolean).join(' ')}. Horaires : ${s.workshop.opening}–${s.workshop.closing}. Taux horaire : ${s.workshop.labor_rate} € HT.
Prestations et forfaits connus (JSON) : ${JSON.stringify(services)}
Consignes du gérant : ${str(notes, 1500) || '(aucune)'}
Donne 6 services (icône = un seul emoji, prix indicatif « dès … € » seulement si tu le connais, sinon « sur devis »), une offre du moment adaptée à la saison (${new Date().toLocaleDateString('fr-LU', { month: 'long' })}), un texte « à propos » de 60 à 100 mots, 4 questions fréquentes, un titre SEO de moins de 60 caractères et une description SEO de moins de 155 caractères. N'invente ni avis clients, ni récompenses, ni chiffres.`,
    }],
    output_config: { format: jsonSchemaOutputFormat(GEN_SCHEMA) },
  });
  const g = resp.parsed_output;
  if (!g) throw new Error('Réponse de l\'IA inutilisable, réessayez');
  const blocks = cfg.blocks.map((b) => {
    if (b.type === 'hero') return { ...b, title: g.hero_title, subtitle: g.hero_subtitle };
    if (b.type === 'services') return { ...b, items: g.services.slice(0, 12) };
    if (b.type === 'promo') return { ...b, title: g.promo_title, text: g.promo_text };
    if (b.type === 'about') return { ...b, title: g.about_title, text: g.about_text };
    if (b.type === 'faq') return { ...b, items: g.faq.slice(0, 15) };
    return b;
  });
  return { ai: true, config: saveWebsite({ ...cfg, blocks, seo_title: g.seo_title, seo_description: g.seo_description }) };
}

// ---------- Formulaire de contact public → CRM ----------
const hits = new Map();
export function submitContact(body, ip) {
  if (!websiteConfig().published) throw Object.assign(new Error('Site non publié'), { status: 404 });
  if (body.website) return { ok: true }; // champ piège anti-robots
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 600_000);
  if (list.length >= 5) throw Object.assign(new Error('Trop de demandes, réessayez plus tard ou appelez-nous.'), { status: 429 });
  hits.set(ip, [...list, now]);
  const name = str(body.name, 80).trim();
  const phone = str(body.phone, 30).trim();
  const email = str(body.email, 120).trim();
  if (!name || (!phone && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) throw Object.assign(new Error('Indiquez votre nom et un téléphone ou un e-mail valide.'), { status: 400 });
  const service = str(body.service, 80);
  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : '';
  const id = saveLead({
    name: `${service || 'Demande'} — ${name}`, contact_name: name, phone, email: email || null, vehicle_plate: str(body.plate, 15).toUpperCase() || null,
    service: service || null, description: [str(body.message, 2000), wanted ? `Date souhaitée : ${wanted.split('-').reverse().join('/')}` : ''].filter(Boolean).join('\n'),
    source: 'site', priority: wanted ? 2 : 1, deadline: wanted || null,
  });
  const admin = get("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1");
  if (admin) {
    createActivity({ model: 'lead', record_id: id, module: 'crm', type: 'call', summary: `Rappeler ${name} (demande du site web${service ? ' : ' + service : ''})`, due_date: new Date().toISOString().slice(0, 10), user_id: admin.id }, admin.id);
  }
  return { ok: true };
}

// ---------- Rendu de la page publique ----------
function block(b, ctx) {
  const { c, s, services } = ctx;
  const title = b.title ? `<h2>${esc(b.title)}</h2>` : '';
  switch (b.type) {
    case 'hero': return `<section class="hero"${b.image ? ` style="--img:url('${esc(b.image)}')"` : ''}><div class="wrap"><h1>${esc(b.title)}</h1><p>${nl2br(b.subtitle)}</p>
      <div class="cta"><a class="btn" href="#contact">${esc(b.cta_label || 'Prendre rendez-vous')}</a>${c.phone ? `<a class="btn ghost" href="tel:${esc(c.phone.replace(/\s/g, ''))}">📞 ${esc(c.phone)}</a>` : ''}</div></div></section>`;
    case 'services': return `<section class="wrap"><div class="head">${title}</div><div class="grid">${(b.items || []).map((i) => `<article class="card"><div class="ico">${esc(i.icon)}</div><h3>${esc(i.name)}</h3><p>${esc(i.text)}</p>${i.price ? `<b class="price">${esc(i.price)}</b>` : ''}</article>`).join('')}</div></section>`;
    case 'promo': return `<section class="wrap"><div class="promo">${b.badge ? `<span class="badge">${esc(b.badge)}</span>` : ''}<h2>${esc(b.title)}</h2><p>${nl2br(b.text)}</p><a class="btn" href="#contact">J'en profite</a></div></section>`;
    case 'about': return `<section class="wrap about${b.image ? ' with-img' : ''}"><div>${title}<p>${nl2br(b.text)}</p></div>${b.image ? `<img src="${esc(b.image)}" alt="" loading="lazy">` : ''}</section>`;
    case 'reviews': return `<section class="wrap"><div class="head">${title}</div><div class="grid">${(b.items || []).map((i) => `<blockquote class="card"><div class="stars">${'★'.repeat(i.stars)}${'☆'.repeat(5 - i.stars)}</div><p>« ${esc(i.text)} »</p><cite>${esc(i.name)}</cite></blockquote>`).join('')}</div></section>`;
    case 'gallery': return (b.images || []).length ? `<section class="wrap"><div class="head">${title}</div><div class="gallery">${b.images.map((u) => `<img src="${esc(u)}" alt="" loading="lazy">`).join('')}</div></section>` : '';
    case 'faq': return `<section class="wrap narrow"><div class="head">${title}</div>${(b.items || []).map((i) => `<details class="card"><summary>${esc(i.q)}</summary><p>${nl2br(i.a)}</p></details>`).join('')}</section>`;
    case 'hours': {
      const addr = [c.address, [c.zip, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      return `<section class="wrap"><div class="head">${title}</div><div class="grid two"><div class="card"><h3>🕘 Horaires</h3><p>Du lundi au vendredi<br><b>${esc(s.workshop.opening)} – ${esc(s.workshop.closing)}</b></p></div>
        <div class="card"><h3>📍 Adresse</h3><p>${esc(addr) || '—'}</p>${addr ? `<a class="link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.name + ' ' + addr)}">Itinéraire →</a>` : ''}</div></div></section>`;
    }
    case 'contact': return `<section class="wrap narrow" id="contact"><div class="head">${title}<p class="muted">${nl2br(b.text)}</p></div>
      <form class="card form" method="post" action="/site-api/contact" onsubmit="return sendForm(event)">
        <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
        <div class="row"><label>Nom *<input name="name" required maxlength="80" autocomplete="name"></label><label>Téléphone<input name="phone" maxlength="30" autocomplete="tel" inputmode="tel"></label></div>
        <div class="row"><label>E-mail<input name="email" type="email" maxlength="120" autocomplete="email"></label><label>Plaque d'immatriculation<input name="plate" maxlength="15"></label></div>
        <div class="row"><label>Prestation<select name="service"><option value="">— Choisir —</option>${services.map((x) => `<option>${esc(x)}</option>`).join('')}<option>Autre</option></select></label><label>Date souhaitée<input name="date" type="date"></label></div>
        <label>Message<textarea name="message" rows="4" maxlength="2000" placeholder="Décrivez votre besoin…"></textarea></label>
        <button class="btn" type="submit">Envoyer ma demande</button><p class="msg" role="status"></p>
      </form>
      <p class="contact-line">${c.phone ? `📞 <a href="tel:${esc(c.phone.replace(/\s/g, ''))}">${esc(c.phone)}</a>` : ''}${c.email ? ` · ✉️ <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</p></section>`;
    default: return '';
  }
}

export function renderSite({ preview = false } = {}) {
  const s = getSettings();
  const c = s.company;
  const w = websiteConfig();
  const accent = w.accent || s.layout?.primary || '#2563eb';
  const blocks = w.blocks.filter((b) => !b.hidden);
  const services = (blocks.find((b) => b.type === 'services')?.items || []).map((i) => i.name).filter(Boolean);
  const logo = s.layout?.logo_version ? `/logo?v=${s.layout.logo_version}` : null;
  const light = w.theme === 'light';
  const body = blocks.map((b) => block(b, { c, s, services })).join('\n')
    .replace(preview ? ' onsubmit="return sendForm(event)"' : '\u0000', ''); // pas de script dans l'aperçu
  const title = w.seo_title || `${c.name} — garage ${c.city || ''}`.trim();
  const ld = { '@context': 'https://schema.org', '@type': 'AutoRepair', name: c.name, telephone: c.phone || undefined, email: c.email || undefined,
    address: { '@type': 'PostalAddress', streetAddress: c.address || undefined, postalCode: c.zip || undefined, addressLocality: c.city || undefined, addressCountry: 'LU' } };
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(w.seo_description)}">${preview ? '<meta name="robots" content="noindex">' : ''}
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(w.seo_description)}">
${preview ? '' : `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`}
<style>
:root{--a:${HEX.test(accent) ? accent : '#2563eb'};--bg:${light ? '#f6f8fc' : '#070b16'};--card:${light ? '#fff' : 'rgba(18,25,44,.75)'};--ink:${light ? '#0b1224' : '#e8eefc'};--mut:${light ? '#5f6d8a' : '#94a3b8'};--line:${light ? '#e2e8f0' : 'rgba(148,170,220,.18)'}}
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);line-height:1.55}
a{color:var(--a)}.wrap{max-width:1120px;margin:0 auto;padding:56px 20px}.narrow{max-width:760px}
header{position:sticky;top:0;z-index:5;backdrop-filter:blur(14px);background:${light ? 'rgba(255,255,255,.8)' : 'rgba(7,11,22,.75)'};border-bottom:1px solid var(--line)}
header .in{max-width:1120px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}
header img{max-height:44px;max-width:200px;${light ? '' : 'background:#fff;padding:4px 8px;border-radius:8px;'}}header b{font-size:20px}
.btn{display:inline-block;background:var(--a);color:#fff;text-decoration:none;padding:13px 22px;border-radius:12px;font-weight:700;border:0;cursor:pointer;font-size:16px;box-shadow:0 10px 30px color-mix(in srgb,var(--a) 35%,transparent)}
.btn.ghost{background:transparent;color:inherit;border:1.5px solid currentColor;box-shadow:none}
.hero{position:relative;color:#fff;background:linear-gradient(120deg,color-mix(in srgb,var(--a) 85%,#000),#0b1224);overflow:hidden}
.hero::before{content:'';position:absolute;inset:0;background:var(--img) center/cover;opacity:.35}
.hero .wrap{position:relative;padding:110px 20px 100px}.hero h1{font-size:clamp(32px,5vw,56px);line-height:1.08;margin:0 0 16px;max-width:780px}
.hero p{font-size:clamp(17px,2vw,21px);max-width:640px;opacity:.92}.cta{display:flex;gap:12px;flex-wrap:wrap;margin-top:26px}
h2{font-size:clamp(26px,3.4vw,36px);margin:0 0 8px}.head{margin-bottom:26px}.muted{color:var(--mut)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}.grid.two{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px;margin:0 0 12px;${light ? 'box-shadow:0 8px 24px rgba(30,50,100,.06);' : ''}}
.card h3{margin:6px 0}.card p{margin:0;color:var(--mut)}.ico{font-size:32px}.price{display:inline-block;margin-top:12px;color:var(--a)}
.promo{border-radius:24px;padding:40px;color:#fff;background:linear-gradient(120deg,var(--a),color-mix(in srgb,var(--a) 40%,#7c3aed))}
.promo p{font-size:18px;max-width:640px}.promo .btn{background:#fff;color:var(--a)}.badge{display:inline-block;background:rgba(255,255,255,.2);padding:4px 12px;border-radius:99px;font-weight:700;font-size:13px}
.about.with-img{display:grid;grid-template-columns:1.2fr 1fr;gap:32px;align-items:center}.about img,.gallery img{width:100%;border-radius:18px;object-fit:cover}
.about p{font-size:18px}.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.gallery img{aspect-ratio:4/3}
.stars{color:#f59e0b;font-size:18px}blockquote p{font-style:italic}cite{display:block;margin-top:10px;font-style:normal;font-weight:600}
details summary{cursor:pointer;font-weight:650}details p{margin-top:10px!important}
.form label{display:block;font-size:14px;font-weight:600;margin-bottom:12px}.form input,.form select,.form textarea{display:block;width:100%;margin-top:6px;padding:12px;border-radius:10px;border:1px solid var(--line);background:${light ? '#f8fafc' : 'rgba(255,255,255,.05)'};color:inherit;font:inherit}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.hp{position:absolute;left:-9999px}.msg{font-weight:600;margin:12px 0 0}.msg.ok{color:#16a34a}.msg.err{color:#dc2626}
.contact-line{text-align:center}footer{border-top:1px solid var(--line);text-align:center;padding:30px 20px;color:var(--mut);font-size:14px}
.preview-bar{position:sticky;top:0;z-index:9;background:#f59e0b;color:#111;text-align:center;font-weight:700;padding:6px;font-size:13px}
@media(max-width:700px){.row,.about.with-img{grid-template-columns:1fr}.wrap{padding:40px 16px}.hero .wrap{padding:70px 16px}.promo{padding:26px}}
</style></head><body>
${preview && !w.published ? '<div class="preview-bar">Aperçu — le site n\'est pas encore publié</div>' : ''}
<header><div class="in">${logo ? `<img src="${logo}" alt="${esc(c.name)}">` : `<b>${esc(c.name)}</b>`}<a class="btn" href="#contact">Rendez-vous</a></div></header>
<main>${body}</main>
<footer>© ${new Date().getFullYear()} ${esc(c.name)}${c.vat_number && c.vat_number !== 'LU' ? ` · TVA ${esc(c.vat_number)}` : ''}${c.rcs ? ` · RCS ${esc(c.rcs)}` : ''}</footer>
${preview ? '' : `<script>
async function sendForm(e){e.preventDefault();const f=e.target,m=f.querySelector('.msg'),b=f.querySelector('button');b.disabled=true;m.className='msg';m.textContent='Envoi…';
try{const r=await fetch('/site-api/contact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});const d=await r.json().catch(()=>({}));
if(!r.ok)throw new Error(d.error||'Envoi impossible');f.reset();m.classList.add('ok');m.textContent='Merci ! Votre demande est bien envoyée, nous vous recontactons très vite.';}
catch(x){m.classList.add('err');m.textContent=x.message;}finally{b.disabled=false;}return false;}
</script>`}</body></html>`;
}

export { SOURCES };
