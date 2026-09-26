// Conversations avec les agents du bureau IA : chaque échange est rangé dans une conversation consultable.
import { db, all, get, run, insert } from './db.js';
import { AGENTS } from './agents.js';

db.exec(`
CREATE TABLE IF NOT EXISTS agent_conversations (
  id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT, pinned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_conv_agent ON agent_conversations(agent_id, updated_at);
`);
if (!all('PRAGMA table_info(agent_messages)').some((c) => c.name === 'conversation_id')) {
  db.exec('ALTER TABLE agent_messages ADD COLUMN conversation_id INTEGER');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_msg_conv ON agent_messages(conversation_id, id)');

// Anciens messages (avant l'historique) : une conversation « Discussions précédentes » par agent
for (const { agent_id: agentId } of all('SELECT DISTINCT agent_id FROM agent_messages WHERE conversation_id IS NULL')) {
  const first = get('SELECT MIN(created_at) a, MAX(created_at) b FROM agent_messages WHERE agent_id=? AND conversation_id IS NULL', agentId);
  const id = insert('agent_conversations', { agent_id: agentId, title: 'Discussions précédentes', created_at: first.a, updated_at: first.b }, ['agent_id', 'title', 'created_at', 'updated_at']);
  run('UPDATE agent_messages SET conversation_id=? WHERE agent_id=? AND conversation_id IS NULL', id, agentId);
}

const titleOf = (text) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 70 ? t.slice(0, 67).replace(/\s\S*$/, '') + '…' : t;
};

/** Conversation existante (vérifiée pour cet agent) ou nouvelle, titrée d'après la première question. */
export function ensureConversation(agentId, conversationId, firstText) {
  if (conversationId) {
    const c = get('SELECT * FROM agent_conversations WHERE id=? AND agent_id=?', conversationId, agentId);
    if (c) return c.id;
  }
  return insert('agent_conversations', { agent_id: agentId, title: titleOf(firstText || 'Nouvelle conversation') }, ['agent_id', 'title']);
}

export function addMessage(conversationId, agentId, role, content) {
  insert('agent_messages', { agent_id: agentId, conversation_id: conversationId, role, content }, ['agent_id', 'conversation_id', 'role', 'content']);
  run('UPDATE agent_conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?', conversationId);
}

export const historyOf = (conversationId, limit = 30) =>
  all('SELECT role, content FROM agent_messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?', conversationId, limit).reverse();

/** Liste des conversations (d'un agent ou de toute l'équipe), avec recherche plein texte. */
export function listConversations({ agent, q, limit = 60 } = {}) {
  const where = [];
  const params = [];
  if (agent) { where.push('c.agent_id=?'); params.push(agent); }
  if (q?.trim()) {
    where.push('(c.title LIKE ? OR EXISTS (SELECT 1 FROM agent_messages m WHERE m.conversation_id=c.id AND m.content LIKE ?))');
    params.push(`%${q.trim()}%`, `%${q.trim()}%`);
  }
  const rows = all(`
    SELECT c.*, (SELECT COUNT(*) FROM agent_messages m WHERE m.conversation_id=c.id) messages,
      (SELECT content FROM agent_messages m WHERE m.conversation_id=c.id ORDER BY id DESC LIMIT 1) last
    FROM agent_conversations c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.pinned DESC, c.updated_at DESC, c.id DESC LIMIT ?`, ...params, limit);
  const names = Object.fromEntries(AGENTS.map((a) => [a.id, a]));
  return rows.map((r) => ({
    ...r, last: (r.last || '').replace(/[#*_`>]/g, '').slice(0, 140),
    agent_name: names[r.agent_id]?.name, agent_emoji: names[r.agent_id]?.emoji, agent_color: names[r.agent_id]?.color,
  }));
}

export const conversationMessages = (id) =>
  all('SELECT id, role, content, created_at FROM agent_messages WHERE conversation_id=? ORDER BY id', id);

export const getConversation = (id) => get('SELECT * FROM agent_conversations WHERE id=?', id);

export function updateConversation(id, { title, pinned }) {
  if (title !== undefined) run('UPDATE agent_conversations SET title=? WHERE id=?', String(title).slice(0, 120), id);
  if (pinned !== undefined) run('UPDATE agent_conversations SET pinned=? WHERE id=?', pinned ? 1 : 0, id);
}

export function deleteConversation(id) {
  run('DELETE FROM agent_messages WHERE conversation_id=?', id);
  run('DELETE FROM agent_conversations WHERE id=?', id);
}
