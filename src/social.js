// Marketing social (inspiré d'Odoo) : rédiger, programmer et publier sur Facebook et Instagram,
// préparer les publications pour Google, LinkedIn et TikTok, idées et textes écrits par l'IA.
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { db, all, get, run, insert, update, getSettings, setSetting, localDateTime } from './db.js';
import { aiConfigured, claudeClient, CLAUDE_MODEL } from './claude.js';
import { BusinessError } from './business.js';

db.exec(`
CREATE TABLE IF NOT EXISTS social_posts (
  id INTEGER PRIMARY KEY, text TEXT NOT NULL, platforms TEXT NOT NULL DEFAULT '[]', image TEXT, link TEXT,
  scheduled_at TEXT, status TEXT DEFAULT 'draft', results TEXT, created_by INTEGER, published_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);

export const PLATFORMS = {
  facebook: { name: 'Facebook', auto: true, max: 5000 },
  instagram: { name: 'Instagram', auto: true, max: 2200, image: true },
  google: { name: 'Google Business', auto: false, max: 1500, url: 'https://business.google.com/' },
  linkedin: { name: 'LinkedIn', auto: false, max: 3000, url: 'https://www.linkedin.com/feed/?shareActive=true' },
  tiktok: { name: 'TikTok', auto: false, max: 2200, url: 'https://www.tiktok.com/upload' },
};
const GRAPH = 'https://graph.facebook.com/v21.0';

// Comptes connectés (les jetons ne sont jamais renvoyés au navigateur)
const accounts = () => getSettings().social || {};
export function publicAccounts() {
  const a = accounts();
  return Object.fromEntries(Object.keys(PLATFORMS).map((k) => [k, { connected: k === 'facebook' ? Boolean(a.facebook?.page_id && a.facebook?.token) : k === 'instagram' ? Boolean(a.instagram?.ig_user_id && a.instagram?.token) : false, name: a[k]?.name || '' }]));
}
export function saveAccounts(input = {}) {
  const cur = accounts();
  const out = { ...cur };
  for (const k of ['facebook', 'instagram']) {
    const src = input[k];
    if (!src) continue;
    if (src.disconnect) { delete out[k]; continue; }
    const idKey = k === 'facebook' ? 'page_id' : 'ig_user_id';
    out[k] = {
      [idKey]: /^\d{5,30}$/.test(src[idKey] || '') ? src[idKey] : cur[k]?.[idKey] || '',
      token: src.token ? String(src.token).trim().slice(0, 600) : cur[k]?.token || '',
      name: String(src.name ?? cur[k]?.name ?? '').slice(0, 80),
    };
  }
  setSetting('social', out);
  return publicAccounts();
}

const parse = (p) => ({ ...p, platforms: JSON.parse(p.platforms || '[]'), results: p.results ? JSON.parse(p.results) : null });
export function listPosts({ from, to } = {}) {
  const where = from && to ? 'WHERE COALESCE(substr(scheduled_at,1,10), substr(published_at,1,10), substr(created_at,1,10)) BETWEEN ? AND ?' : '';
  return all(`SELECT * FROM social_posts ${where} ORDER BY COALESCE(scheduled_at, published_at, created_at) DESC LIMIT 300`, ...(where ? [from, to] : [])).map(parse);
}
export const getPost = (id) => { const p = get('SELECT * FROM social_posts WHERE id=?', id); if (!p) throw new BusinessError('Publication introuvable', 404); return parse(p); };

export function savePost(data, userId, id = null) {
  const text = String(data.text || '').trim();
  if (!text) throw new BusinessError('Le texte de la publication est vide');
  const platforms = (Array.isArray(data.platforms) ? data.platforms : []).filter((p) => PLATFORMS[p]);
  if (!platforms.length) throw new BusinessError('Choisissez au moins un réseau');
  for (const p of platforms) if (text.length > PLATFORMS[p].max) throw new BusinessError(`${PLATFORMS[p].name} : ${PLATFORMS[p].max} caractères maximum`);
  if (platforms.includes('instagram') && !data.image) throw new BusinessError('Instagram demande une image');
  const image = /^\/site-media\/[a-f0-9]{24}\.(png|jpg|webp)$/.test(data.image || '') ? data.image : null;
  const link = /^https?:\/\/\S+$/.test(data.link || '') ? String(data.link).slice(0, 500) : null;
  const scheduled = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(data.scheduled_at || '') ? data.scheduled_at.slice(0, 16) : null;
  const status = data.status === 'draft' ? 'draft' : scheduled ? 'scheduled' : 'draft';
  const row = { text: text.slice(0, 5000), platforms: JSON.stringify(platforms), image, link, scheduled_at: scheduled, status };
  if (id) {
    const cur = getPost(id);
    if (['published', 'partial'].includes(cur.status)) throw new BusinessError('Publication déjà publiée');
    update('social_posts', id, row, Object.keys(row));
    return id;
  }
  return insert('social_posts', { ...row, created_by: userId }, [...Object.keys(row), 'created_by']);
}

async function graph(pathname, params) {
  const res = await fetch(`${GRAPH}/${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.error) throw new Error(d.error?.message || `Erreur ${res.status}`);
  return d;
}

/** Publie maintenant sur les réseaux connectés ; les autres sont marqués « à publier à la main ». */
export async function publishPost(id, publicBase) {
  const p = getPost(id);
  const a = accounts();
  const imageUrl = p.image && publicBase ? `${publicBase.replace(/\/$/, '')}${p.image}` : null;
  const results = {};
  for (const platform of p.platforms) {
    try {
      if (platform === 'facebook') {
        if (!a.facebook?.token) throw new Error('Page Facebook non connectée');
        const r = imageUrl
          ? await graph(`${a.facebook.page_id}/photos`, { url: imageUrl, caption: p.text + (p.link ? `\n${p.link}` : ''), access_token: a.facebook.token })
          : await graph(`${a.facebook.page_id}/feed`, { message: p.text, ...(p.link ? { link: p.link } : {}), access_token: a.facebook.token });
        results.facebook = { ok: true, id: r.post_id || r.id };
      } else if (platform === 'instagram') {
        if (!a.instagram?.token) throw new Error('Compte Instagram non connecté');
        if (!imageUrl || !/^https:/.test(imageUrl)) throw new Error('Instagram a besoin d\'une image accessible sur internet (adresse publique https dans Paramètres)');
        const c = await graph(`${a.instagram.ig_user_id}/media`, { image_url: imageUrl, caption: p.text, access_token: a.instagram.token });
        const r = await graph(`${a.instagram.ig_user_id}/media_publish`, { creation_id: c.id, access_token: a.instagram.token });
        results.instagram = { ok: true, id: r.id };
      } else {
        results[platform] = { ok: false, manual: true, error: 'À publier à la main (texte prêt à copier)' };
      }
    } catch (e) {
      results[platform] = { ok: false, error: e.message };
    }
  }
  const auto = Object.entries(results).filter(([k]) => PLATFORMS[k].auto);
  const okAuto = auto.filter(([, r]) => r.ok).length;
  const status = !auto.length ? 'manual' : okAuto === auto.length ? (Object.values(results).some((r) => r.manual) ? 'partial' : 'published') : okAuto ? 'partial' : 'error';
  run('UPDATE social_posts SET status=?, results=?, published_at=? WHERE id=?', status, JSON.stringify(results), okAuto ? localDateTime() : null, id);
  return getPost(id);
}

export function markManualDone(id) {
  const p = getPost(id);
  const results = { ...(p.results || {}) };
  for (const k of p.platforms) if (!PLATFORMS[k].auto) results[k] = { ok: true, manual: true };
  const allOk = p.platforms.every((k) => results[k]?.ok);
  run('UPDATE social_posts SET status=?, results=?, published_at=COALESCE(published_at, ?) WHERE id=?', allOk ? 'published' : 'partial', JSON.stringify(results), localDateTime(), id);
  return getPost(id);
}

// ---------- IA : idées et rédaction ----------
const POSTS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['posts'],
  properties: { posts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['platform', 'text'], properties: { platform: { type: 'string', enum: Object.keys(PLATFORMS) }, text: { type: 'string' } } } } },
};
const IDEAS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ideas'],
  properties: { ideas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'brief', 'best_day'], properties: { title: { type: 'string' }, brief: { type: 'string' }, best_day: { type: 'string' } } } } },
};
const garageLine = () => { const s = getSettings(); return `${s.company.name} (${s.company.city || 'Luxembourg'}), garage automobile toutes marques. Téléphone : ${s.company.phone || '—'}.`; };

export async function writePosts({ topic, platforms = ['facebook', 'instagram'], tone = 'chaleureux' }) {
  const list = platforms.filter((p) => PLATFORMS[p]);
  if (!String(topic || '').trim()) throw new BusinessError('Indiquez le sujet de la publication');
  if (!aiConfigured()) {
    return { ai: false, posts: list.map((p) => ({ platform: p, text: `${topic}\n\n📍 ${getSettings().company.name} — prenez rendez-vous dès maintenant !${p === 'instagram' ? '\n\n#garage #luxembourg #entretien #auto' : ''}` })) };
  }
  const resp = await claudeClient().messages.parse({
    model: CLAUDE_MODEL, max_tokens: 16000,
    messages: [{ role: 'user', content: `Tu es responsable marketing de ${garageLine()}
Écris une publication pour chacun de ces réseaux : ${list.map((p) => PLATFORMS[p].name).join(', ')}. Sujet : ${String(topic).slice(0, 1500)}. Ton : ${String(tone).slice(0, 40)}. En français.
Adapte chaque texte au réseau (Facebook : 2-4 phrases + appel à l'action ; Instagram : accroche, emojis, 5 à 8 hashtags à la fin ; Google Business : sobre, 1-3 phrases ; LinkedIn : professionnel ; TikTok : très court et punchy). N'invente ni prix ni promotion qui ne sont pas dans le sujet.` }],
    output_config: { format: jsonSchemaOutputFormat(POSTS_SCHEMA) },
  });
  return { ai: true, posts: (resp.parsed_output?.posts || []).filter((p) => list.includes(p.platform)).map((p) => ({ ...p, text: p.text.slice(0, PLATFORMS[p.platform].max) })) };
}

export async function postIdeas() {
  const month = new Date().toLocaleDateString('fr-LU', { month: 'long' });
  if (!aiConfigured()) {
    return { ai: false, ideas: [
      { title: 'Rappel pneus hiver / été', brief: 'Rappeler de prendre rendez-vous pour le changement de pneus avant la saison.', best_day: 'mardi' },
      { title: 'Coulisses de l\'atelier', brief: 'Photo d\'un mécanicien au travail avec une astuce d\'entretien.', best_day: 'jeudi' },
      { title: 'Avant / après', brief: 'Montrer une réparation réussie (carrosserie, jantes, phares).', best_day: 'samedi' },
      { title: 'Conseil de la semaine', brief: 'Vérifier la pression des pneus et les niveaux avant un long trajet.', best_day: 'vendredi' },
      { title: 'Présentation de l\'équipe', brief: 'Présenter un membre de l\'équipe et sa spécialité.', best_day: 'lundi' },
    ] };
  }
  const resp = await claudeClient().messages.parse({
    model: CLAUDE_MODEL, max_tokens: 16000,
    messages: [{ role: 'user', content: `Propose 6 idées de publications sur les réseaux sociaux pour ${garageLine()} Nous sommes en ${month}, au Luxembourg : tiens compte de la saison, des fêtes et des obligations (pneus, contrôle technique, climatisation, vacances). Pour chaque idée : un titre court, un brief de 1 à 2 phrases, et le meilleur jour de la semaine pour publier. En français.` }],
    output_config: { format: jsonSchemaOutputFormat(IDEAS_SCHEMA) },
  });
  return { ai: true, ideas: resp.parsed_output?.ideas || [] };
}

// Publications programmées : publiées automatiquement à l'heure prévue
export async function publishDue(publicBase) {
  const due = all("SELECT id FROM social_posts WHERE status='scheduled' AND scheduled_at <= ?", localDateTime().slice(0, 16));
  for (const p of due) {
    try { await publishPost(p.id, publicBase); } catch (e) { run("UPDATE social_posts SET status='error', results=? WHERE id=?", JSON.stringify({ error: e.message }), p.id); }
  }
  return due.length;
}
