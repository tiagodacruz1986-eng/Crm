// Appel des agents IA via l'API Claude (boucle d'outils manuelle + recherche web).
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { AGENTS, TOOLS, getAgent, runTool, systemPrompt } from './agents.js';
import { all, run, insert, dataDir } from './db.js';
import { BusinessError } from './business.js';
import { ensureConversation, addMessage, historyOf } from './conversations.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';

// ---------- Clé Claude ----------
// Deux façons de la fournir : l'administrateur la colle dans Paramètres → Agents IA (elle est rangée dans le dossier des
// données, fichier « claude.key », et n'est plus jamais renvoyée à l'écran), ou la variable ANTHROPIC_API_KEY du fichier .env.
// La clé saisie dans le logiciel passe avant celle du fichier .env. Elle n'est pas dans la base : ni les paramètres
// envoyés aux écrans, ni les outils des agents ne peuvent la lire.
const KEY_FILE = path.join(dataDir, 'claude.key');
// Une clé d'exemple laissée telle quelle dans .env (« sk-ant-... ») ne compte pas comme une vraie clé
const realKey = (k) => Boolean(k && k.trim() && !/^sk-ant-\.\.\.$/.test(k.trim()));
let storedKey = null;
try { const k = fs.readFileSync(KEY_FILE, 'utf8').trim(); if (realKey(k)) storedKey = k; } catch { /* aucune clé enregistrée */ }
export const aiConfigured = () => Boolean(storedKey) || realKey(process.env.ANTHROPIC_API_KEY) || realKey(process.env.ANTHROPIC_AUTH_TOKEN);

let client = null, clientKey = null;
function getClient() {
  if (!client || clientKey !== storedKey) {
    // clé saisie dans le logiciel : elle seule sert (ni la clé ni le jeton de l'environnement)
    client = storedKey ? new Anthropic({ apiKey: storedKey, authToken: null }) : new Anthropic();
    clientKey = storedKey;
  }
  return client;
}

const keyHint = (k) => `sk-ant-…${k.slice(-4)}`;
/** État de la clé pour l'écran des paramètres — jamais la clé elle-même, seulement ses 4 derniers caractères. */
export function apiKeyStatus() {
  const env = realKey(process.env.ANTHROPIC_API_KEY) ? process.env.ANTHROPIC_API_KEY.trim() : null;
  if (storedKey) return { source: 'settings', hint: keyHint(storedKey), model: MODEL, env: Boolean(env) };
  if (env) return { source: 'env', hint: keyHint(env), model: MODEL, env: true };
  if (realKey(process.env.ANTHROPIC_AUTH_TOKEN)) return { source: 'env', hint: null, model: MODEL, env: true };
  return { source: null, hint: null, model: MODEL, env: false };
}

// Pourquoi l'essai de la clé a échoué, en clair pour l'administrateur
function keyTestError(e) {
  const end = ' La clé n\'a pas été enregistrée.';
  if (e instanceof Anthropic.AuthenticationError) return 'Anthropic refuse cette clé. Vérifiez que vous l\'avez copiée en entier et qu\'elle n\'a pas été supprimée dans la console Anthropic.' + end;
  if (e instanceof Anthropic.PermissionDeniedError) return 'Cette clé n\'a pas le droit d\'utiliser le service (compte ou espace de travail restreint dans la console Anthropic).' + end;
  if (e instanceof Anthropic.NotFoundError) return `La clé est reconnue, mais le modèle réglé dans le logiciel (${MODEL}) n'est pas disponible pour ce compte.` + end;
  if (e instanceof Anthropic.RateLimitError) return 'Anthropic limite ce compte pour l\'instant (trop de demandes, ou plafond de dépense atteint). Réessayez dans une minute.' + end;
  if (e instanceof Anthropic.BadRequestError) {
    const detail = String(e.error?.error?.message || e.message || '').replace(/\s+/g, ' ').slice(0, 240);
    return `Anthropic a refusé l'essai : « ${detail} ». Le plus souvent, le compte n'a pas encore de crédit : dans la console Anthropic, ouvrez « Billing » et ajoutez un moyen de paiement.` + end;
  }
  if (e instanceof Anthropic.APIConnectionError) return 'Impossible de joindre Anthropic pour vérifier la clé (connexion internet ?).' + end;
  if (e instanceof Anthropic.APIError) return 'Le service d\'Anthropic est momentanément indisponible : réessayez dans un instant.' + end;
  return 'La clé n\'a pas pu être vérifiée : réessayez.' + end;
}

/**
 * Enregistre la clé collée par l'administrateur. Elle est d'abord essayée pour de bon (une très courte demande, au coût
 * négligeable) : clé refusée, compte sans crédit ou modèle indisponible se voient tout de suite, et rien n'est enregistré.
 */
export async function saveApiKey(raw) {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) throw new BusinessError('Collez votre clé Claude.');
  if (!/^sk-ant-[A-Za-z0-9_-]{16,400}$/.test(key)) throw new BusinessError('Ce texte ne ressemble pas à une clé Claude : elle commence par « sk-ant- » et ne contient ni espace ni retour à la ligne. Copiez-la en entier depuis la console Anthropic.');
  const probe = new Anthropic({ apiKey: key, authToken: null, maxRetries: 0, timeout: 20_000 });
  try {
    await probe.messages.create({ model: MODEL, max_tokens: 32, messages: [{ role: 'user', content: 'Réponds simplement : ok' }] });
  } catch (e) {
    if (!(e instanceof Anthropic.APIError)) console.error('Essai de la clé Claude :', e.message);
    throw new BusinessError(keyTestError(e));
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(KEY_FILE, key + '\n', { mode: 0o600 });
  try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* sans effet sous Windows */ }
  storedKey = key;
  return apiKeyStatus();
}
/** Retire la clé saisie dans le logiciel (celle du fichier .env, s'il y en a une, reprend alors du service). */
export function removeApiKey() {
  fs.rmSync(KEY_FILE, { force: true });
  storedKey = null;
  return apiKeyStatus();
}

const WEB_SEARCH = { type: 'web_search_20260209', name: 'web_search', max_uses: 5, user_location: { type: 'approximate', country: 'LU', city: 'Luxembourg', timezone: 'Europe/Luxembourg' } };

/**
 * Boucle d'appel à Claude avec outils : exécute les outils demandés jusqu'à la réponse finale.
 * `execTool(name, input)` exécute un outil local ; `webSearch` ajoute la recherche web.
 */
export async function runLoop({ system, messages, tools, execTool, webSearch = true, onStatus, onTool }) {
  const convo = messages.map((m) => ({ role: m.role, content: m.content }));
  const sys = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  const texts = [];
  for (let i = 0; i < 12; i++) {
    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: sys,
      tools: webSearch ? [...tools, WEB_SEARCH] : tools,
      messages: convo,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    if (response.stop_reason === 'refusal') return 'Je ne peux pas traiter cette demande telle quelle. Pouvez-vous la reformuler ?';
    for (const b of response.content) if (b.type === 'text' && b.text.trim()) texts.push(b.text);
    if (response.stop_reason === 'pause_turn') { convo.push({ role: 'assistant', content: response.content }); continue; }
    if (response.stop_reason !== 'tool_use') break;
    convo.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const b of response.content) {
      if (b.type !== 'tool_use') continue;
      onStatus?.(`Consulte : ${b.name}`);
      try {
        const out = await execTool(b.name, b.input || {});
        onTool?.(b.name, b.input || {}, out);
        results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out ?? null).slice(0, 60000) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: b.id, content: `Erreur : ${e.message}`, is_error: true });
      }
    }
    convo.push({ role: 'user', content: results });
    texts.length = 0; // on ne garde que le texte du dernier tour (réponse finale)
  }
  return texts.join('\n\n').trim() || '(pas de réponse)';
}

/**
 * Fait travailler un agent sur une conversation. `messages` : [{role, content: string}]
 * Retourne le texte final de la réponse.
 */
export async function runAgent(agentId, messages, { onStatus, user = null } = {}) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Agent inconnu');
  if (!aiConfigured()) {
    return `⚠️ **Mode démo** — aucune clé Claude n'est configurée.\n\nPour activer ${agent.name}, l'administrateur colle la clé dans **Paramètres → Agents IA** (les étapes y sont expliquées).`;
  }
  return runLoop({ system: systemPrompt(agent), messages, tools: TOOLS, execTool: (n, i) => runTool(n, i, user), onStatus });
}

export const claudeClient = getClient;
export const CLAUDE_MODEL = MODEL;

export function friendlyError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Clé API Claude invalide. L\'administrateur peut la remplacer dans Paramètres → Agents IA.';
  if (e instanceof Anthropic.RateLimitError) return 'Trop de demandes en même temps. Réessayez dans une minute.';
  if (e instanceof Anthropic.APIConnectionError) return 'Impossible de joindre le service IA (connexion internet ?).';
  if (e instanceof Anthropic.APIError) return `Erreur du service IA (${e.status}) : ${e.message}`;
  return e.message || String(e);
}

// Conversation persistante avec un agent (rangée dans l'historique)
export async function chat(agentId, userText, conversationId = null, user = null) {
  if (!getAgent(agentId)) throw new Error('Agent inconnu');
  const cid = ensureConversation(agentId, conversationId, userText, user);
  addMessage(cid, agentId, 'user', userText);
  const history = historyOf(cid);
  while (history.length && history[0].role !== 'user') history.shift();
  let reply;
  try {
    reply = await runAgent(agentId, history, { user });
  } catch (e) {
    reply = `❌ ${friendlyError(e)}`;
  }
  addMessage(cid, agentId, 'assistant', reply);
  return { reply, conversation_id: cid };
}

// Réunion : tous les agents répondent, puis le CIO fait la synthèse
export async function meeting(question, user = null) {
  const others = AGENTS.filter((a) => a.id !== 'cio');
  const answers = await Promise.all(others.map(async (a) => {
    try {
      return { agent: a, text: await runAgent(a.id, [{ role: 'user', content: `Réunion d'équipe — question du gérant : ${question}\n\nDonne ton point de vue d'expert en 10 lignes maximum.` }], { user }) };
    } catch (e) {
      return { agent: a, text: `❌ ${friendlyError(e)}` };
    }
  }));
  const summaryPrompt = `Réunion d'équipe — question du gérant : ${question}\n\nAvis de l'équipe :\n\n${answers.map((r) => `### ${r.agent.name} (${r.agent.role})\n${r.text}`).join('\n\n')}\n\nFais la synthèse en tant que CIO : décisions recommandées, plan d'action priorisé (qui fait quoi, quand) et points de vigilance.`;
  let synthesis;
  try { synthesis = await runAgent('cio', [{ role: 'user', content: summaryPrompt }], { user }); } catch (e) { synthesis = `❌ ${friendlyError(e)}`; }
  const content = `## Réunion : ${question}\n\n${answers.map((r) => `### ${r.agent.emoji} ${r.agent.name} — ${r.agent.role}\n${r.text}`).join('\n\n')}\n\n---\n\n## 🚀 Synthèse d'Alex (CIO)\n${synthesis}`;
  insert('agent_results', { agent_id: 'cio', title: `Réunion : ${question.slice(0, 80)}`, content, user_id: user?.id ?? null }, ['agent_id', 'title', 'content', 'user_id']);
  return { answers: answers.map((r) => ({ agent_id: r.agent.id, text: r.text })), synthesis, content };
}

/** Efface les conversations d'un utilisateur avec cet agent (le gérant efface aussi les anciennes, sans propriétaire). */
export function clearHistory(agentId, user = null) {
  const mine = user ? `AND (user_id=${Number(user.id)}${user.role === 'admin' ? ' OR user_id IS NULL' : ''})` : '';
  run(`DELETE FROM agent_messages WHERE conversation_id IN (SELECT id FROM agent_conversations WHERE agent_id=? ${mine})`, agentId);
  if (!user) run('DELETE FROM agent_messages WHERE agent_id=?', agentId);
  run(`DELETE FROM agent_conversations WHERE agent_id=? ${mine}`, agentId);
}
