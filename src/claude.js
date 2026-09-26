// Appel des agents IA via l'API Claude (boucle d'outils manuelle + recherche web).
import Anthropic from '@anthropic-ai/sdk';
import { AGENTS, TOOLS, getAgent, runTool, systemPrompt } from './agents.js';
import { all, run, insert } from './db.js';
import { ensureConversation, addMessage, historyOf } from './conversations.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
let client = null;
const getClient = () => (client ??= new Anthropic());

export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

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
export async function runAgent(agentId, messages, { onStatus } = {}) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Agent inconnu');
  if (!aiConfigured()) {
    return `⚠️ **Mode démo** — aucune clé API Claude n'est configurée.\n\nPour activer ${agent.name}, ajoutez \`ANTHROPIC_API_KEY=...\` dans le fichier \`.env\` puis redémarrez le logiciel (voir README).`;
  }
  return runLoop({ system: systemPrompt(agent), messages, tools: TOOLS, execTool: (n, i) => runTool(n, i), onStatus });
}

export const claudeClient = getClient;
export const CLAUDE_MODEL = MODEL;

export function friendlyError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Clé API Claude invalide. Vérifiez ANTHROPIC_API_KEY dans le fichier .env.';
  if (e instanceof Anthropic.RateLimitError) return 'Trop de demandes en même temps. Réessayez dans une minute.';
  if (e instanceof Anthropic.APIConnectionError) return 'Impossible de joindre le service IA (connexion internet ?).';
  if (e instanceof Anthropic.APIError) return `Erreur du service IA (${e.status}) : ${e.message}`;
  return e.message || String(e);
}

// Conversation persistante avec un agent (rangée dans l'historique)
export async function chat(agentId, userText, conversationId = null) {
  if (!getAgent(agentId)) throw new Error('Agent inconnu');
  const cid = ensureConversation(agentId, conversationId, userText);
  addMessage(cid, agentId, 'user', userText);
  const history = historyOf(cid);
  while (history.length && history[0].role !== 'user') history.shift();
  let reply;
  try {
    reply = await runAgent(agentId, history);
  } catch (e) {
    reply = `❌ ${friendlyError(e)}`;
  }
  addMessage(cid, agentId, 'assistant', reply);
  return { reply, conversation_id: cid };
}

// Réunion : tous les agents répondent, puis le CIO fait la synthèse
export async function meeting(question) {
  const others = AGENTS.filter((a) => a.id !== 'cio');
  const answers = await Promise.all(others.map(async (a) => {
    try {
      return { agent: a, text: await runAgent(a.id, [{ role: 'user', content: `Réunion d'équipe — question du gérant : ${question}\n\nDonne ton point de vue d'expert en 10 lignes maximum.` }]) };
    } catch (e) {
      return { agent: a, text: `❌ ${friendlyError(e)}` };
    }
  }));
  const summaryPrompt = `Réunion d'équipe — question du gérant : ${question}\n\nAvis de l'équipe :\n\n${answers.map((r) => `### ${r.agent.name} (${r.agent.role})\n${r.text}`).join('\n\n')}\n\nFais la synthèse en tant que CIO : décisions recommandées, plan d'action priorisé (qui fait quoi, quand) et points de vigilance.`;
  let synthesis;
  try { synthesis = await runAgent('cio', [{ role: 'user', content: summaryPrompt }]); } catch (e) { synthesis = `❌ ${friendlyError(e)}`; }
  const content = `## Réunion : ${question}\n\n${answers.map((r) => `### ${r.agent.emoji} ${r.agent.name} — ${r.agent.role}\n${r.text}`).join('\n\n')}\n\n---\n\n## 🚀 Synthèse d'Alex (CIO)\n${synthesis}`;
  insert('agent_results', { agent_id: 'cio', title: `Réunion : ${question.slice(0, 80)}`, content }, ['agent_id', 'title', 'content']);
  return { answers: answers.map((r) => ({ agent_id: r.agent.id, text: r.text })), synthesis, content };
}

export function clearHistory(agentId) {
  run('DELETE FROM agent_messages WHERE agent_id=?', agentId);
  run('DELETE FROM agent_conversations WHERE agent_id=?', agentId);
}
