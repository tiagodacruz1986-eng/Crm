// Programmation des tâches des agents (une fois, chaque jour, chaque semaine, chaque mois).
import { all, run, insert, localDateTime } from './db.js';
import { runAgent, friendlyError } from './claude.js';
import { getAgent } from './agents.js';

export const running = new Set(); // agents en train de travailler (affiché dans le bureau 3D)

export function computeNextRun(task, from = new Date()) {
  if (task.schedule_type === 'once') {
    const d = task.run_at ? new Date(task.run_at) : from;
    return task.last_run ? null : localDateTime(d);
  }
  const [h, m] = String(task.schedule_time || '08:00').split(':').map(Number);
  const c = new Date(from);
  c.setSeconds(0, 0);
  c.setHours(h, m);
  const advance = () => {
    if (task.schedule_type === 'daily') c.setDate(c.getDate() + 1);
    else if (task.schedule_type === 'weekly') c.setDate(c.getDate() + 7);
    else if (task.schedule_type === 'weekdays') { do c.setDate(c.getDate() + 1); while ([0, 6].includes(c.getDay())); }
    else c.setMonth(c.getMonth() + 1);
  };
  if (task.schedule_type === 'weekly') {
    const target = Number(task.schedule_day ?? 1); // 0 = dimanche
    c.setDate(c.getDate() + ((target - c.getDay() + 7) % 7));
  } else if (task.schedule_type === 'monthly') {
    c.setDate(Math.min(Number(task.schedule_day || 1), 28));
  } else if (task.schedule_type === 'weekdays') {
    while ([0, 6].includes(c.getDay())) c.setDate(c.getDate() + 1);
  }
  while (c <= from) advance();
  return localDateTime(c);
}

export async function executeTask(task) {
  const agent = getAgent(task.agent_id);
  running.add(task.agent_id);
  run("UPDATE agent_tasks SET last_status='running' WHERE id=?", task.id);
  let content, status = 'ok';
  try {
    content = await runAgent(task.agent_id, [{
      role: 'user',
      content: `Tâche programmée « ${task.title} » (exécution du ${new Date().toLocaleString('fr-LU')}).\n\n${task.prompt}\n\nProduis un rapport directement exploitable par le gérant.`,
    }]);
  } catch (e) {
    content = `❌ ${friendlyError(e)}`;
    status = 'error';
  } finally {
    running.delete(task.agent_id);
  }
  insert('agent_results', { task_id: task.id, agent_id: task.agent_id, title: `${agent?.emoji || ''} ${task.title}`, content, status },
    ['task_id', 'agent_id', 'title', 'content', 'status']);
  const now = new Date();
  const next = task.schedule_type === 'once' ? null : computeNextRun(task, now);
  run('UPDATE agent_tasks SET last_run=?, last_status=?, next_run=?, active=? WHERE id=?',
    localDateTime(now), status, next, next ? task.active : 0, task.id);
  return content;
}

export function startScheduler() {
  const tick = async () => {
    const due = all('SELECT * FROM agent_tasks WHERE active=1 AND next_run IS NOT NULL AND next_run<=?', localDateTime());
    for (const t of due) {
      if (running.has(t.agent_id)) continue;
      // On décale immédiatement pour éviter une double exécution
      run('UPDATE agent_tasks SET next_run=NULL WHERE id=?', t.id);
      executeTask(t).catch((e) => console.error('Tâche', t.id, e));
    }
  };
  setInterval(tick, 30_000);
  setTimeout(tick, 3_000);
  // Une tâche restée "running" (serveur arrêté) repart normalement
  for (const t of all("SELECT * FROM agent_tasks WHERE active=1 AND next_run IS NULL")) {
    run('UPDATE agent_tasks SET next_run=? WHERE id=?', computeNextRun({ ...t, last_run: t.schedule_type === 'once' ? null : t.last_run }), t.id);
  }
}

