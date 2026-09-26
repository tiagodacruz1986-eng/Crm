// Bureau IA : chaque échange est rangé dans une conversation, consultable et recherchable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-conv-'));
const seen = [];
const claude = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = JSON.parse(b);
    seen.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: `Réponse n°${seen.length}` }] }));
  });
});

let C, K;
before(async () => {
  await new Promise((r) => claude.listen(0, r));
  // Base existante avec d'anciens messages (avant l'historique des conversations)
  const legacy = new DatabaseSync(path.join(dataDir, 'garage.db'));
  legacy.exec(`CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO agent_messages (agent_id, role, content) VALUES ('avocat', 'user', 'Ancienne question sur le droit de rétention'), ('avocat', 'assistant', 'Ancienne réponse');`);
  legacy.close();
  Object.assign(process.env, { DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: `http://localhost:${claude.address().port}` });
  C = await import('../src/conversations.js');
  K = await import('../src/claude.js');
});
after(() => { claude.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('les anciens messages sont rangés dans une conversation', () => {
  const [old] = C.listConversations({ agent: 'avocat' });
  assert.equal(old.title, 'Discussions précédentes');
  assert.equal(old.messages, 2);
  assert.equal(C.conversationMessages(old.id)[0].content, 'Ancienne question sur le droit de rétention');
});

test('conversation créée, poursuivie, puis une nouvelle conversation repart de zéro', async () => {
  const a = await K.chat('comptable', 'Quel est mon solde bancaire chez BGL ?');
  assert.ok(a.conversation_id);
  assert.equal(C.getConversation(a.conversation_id).title, 'Quel est mon solde bancaire chez BGL ?');
  const b = await K.chat('comptable', 'Et les impayés ?', a.conversation_id);
  assert.equal(b.conversation_id, a.conversation_id);
  assert.equal(seen.at(-1).messages.length, 3); // question, réponse, nouvelle question
  const c = await K.chat('comptable', 'Prépare la TVA du trimestre');
  assert.notEqual(c.conversation_id, a.conversation_id);
  assert.equal(seen.at(-1).messages.length, 1); // pas de mélange avec l'autre conversation
  // Une conversation d'un autre agent n'est jamais réutilisée
  const d = await K.chat('marketing', 'Idée de campagne', a.conversation_id);
  assert.notEqual(d.conversation_id, a.conversation_id);

  assert.equal(C.listConversations({ agent: 'comptable' }).length, 2);
  const hits = C.listConversations({ q: 'impayés' });
  assert.deepEqual(hits.map((h) => h.id), [a.conversation_id]);
  assert.equal(hits[0].agent_name, 'Claire');
  assert.equal(C.listConversations().length, 4);

  C.updateConversation(a.conversation_id, { title: 'Banque BGL', pinned: true });
  assert.equal(C.listConversations({ agent: 'comptable' })[0].title, 'Banque BGL'); // épinglée en premier
  C.deleteConversation(a.conversation_id);
  assert.ok(!C.getConversation(a.conversation_id));
  assert.equal(C.conversationMessages(a.conversation_id).length, 0);
});
