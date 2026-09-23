import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { GET, POST, PUT, DEL, act, toast, datetime, store } from '../api.js';
import { route } from '../router.js';

const md = (s) => DOMPurify.sanitize(marked.parse(s || ''));

const SUGGESTIONS = {
  comptable: ['Fais le point sur ma trésorerie et mes impayés', 'Prépare mon décompte de TVA du trimestre', 'Quelle est ma marge sur les pièces vs la main-d\'œuvre ?'],
  marketing: ['Crée une campagne pneus hiver pour Facebook et Instagram', 'Liste les clients à relancer pour le contrôle technique', 'Propose 5 idées pour avoir plus d\'avis Google'],
  secretariat: ['Résume-moi les rendez-vous de la semaine', 'Rédige les relances pour les factures en retard', 'Écris un e-mail de confirmation de rendez-vous type'],
  atelier: ['Quelle est la productivité de l\'atelier cette semaine ?', 'Quels OR sont en retard ou dépassent le temps vendu ?', 'Quelles pièces dois-je commander ?'],
  avocat: ['Un client refuse de payer une réparation, que faire ?', 'Ai-je un droit de rétention sur le véhicule ?', 'Quelles mentions obligatoires sur mes factures au Luxembourg ?'],
  cio: ['Où sera mon garage dans 5 ans ? Fais-moi une feuille de route', 'Dois-je investir dans l\'entretien des véhicules électriques ?', 'Quels outils digitaux mettre en place en priorité ?'],
};
const SCHEDULES = { once: 'Une fois', daily: 'Tous les jours', weekdays: 'Du lundi au vendredi', weekly: 'Chaque semaine', monthly: 'Chaque mois' };
const DAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const TEMPLATES = {
  comptable: { title: 'Point trésorerie hebdomadaire', prompt: 'Analyse la trésorerie, les factures impayées et en retard, les dettes fournisseurs et le CA de la semaine. Signale les risques et propose des actions.', schedule_type: 'weekly', schedule_day: 1, schedule_time: '08:00' },
  marketing: { title: 'Relances contrôle technique', prompt: 'Liste les clients dont le contrôle technique ou l\'entretien arrive dans les 30 prochains jours et rédige un SMS et un e-mail de rappel personnalisables.', schedule_type: 'weekly', schedule_day: 1, schedule_time: '09:00' },
  secretariat: { title: 'Agenda du jour', prompt: 'Résume les rendez-vous du jour et de demain, les véhicules à rendre et les relances de paiement à faire aujourd\'hui.', schedule_type: 'weekdays', schedule_time: '07:45' },
  atelier: { title: 'Rapport atelier du soir', prompt: 'Fais le bilan de la journée : OR terminés, OR en retard, heures pointées vs vendues par mécanicien, pièces à commander.', schedule_type: 'weekdays', schedule_time: '18:00' },
  avocat: { title: 'Veille juridique mensuelle', prompt: 'Fais une veille des nouveautés légales au Luxembourg utiles à un garage (droit du travail, consommation, TVA, environnement, véhicules) et leur impact.', schedule_type: 'monthly', schedule_day: 1, schedule_time: '08:00' },
  cio: { title: 'Rapport stratégique mensuel', prompt: 'Analyse les chiffres du mois, compare aux mois précédents, identifie les tendances et mets à jour la feuille de route à 12 mois avec 3 priorités.', schedule_type: 'monthly', schedule_day: 1, schedule_time: '08:30' },
};

export const Office = {
  setup() {
    const agents = ref([]);
    const selected = ref(null);
    const tab = ref('chat');
    const messages = ref([]);
    const input = ref('');
    const sending = ref(false);
    const tasks = ref([]);
    const results = ref([]);
    const taskEdit = ref(null);
    const meeting = reactive({ open: false, question: '', running: false, content: '' });
    const view3d = ref(true);
    const stage = ref(null);
    const chatBox = ref(null);
    let office = null;
    let poll;

    const agent = computed(() => agents.value.find((a) => a.id === selected.value));
    const loadAgents = async () => {
      agents.value = await GET('/agents');
      office?.update(agents.value);
    };
    const scrollDown = () => nextTick(() => { if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight; });
    const loadAgentData = async () => {
      if (!selected.value) return;
      const id = selected.value;
      [messages.value, tasks.value, results.value] = await Promise.all([GET(`/agents/${id}/messages`), GET(`/agent-tasks?agent=${id}`), GET(`/agent-results?agent=${id}`)]);
      scrollDown();
    };
    const select = async (id) => {
      selected.value = id;
      office?.focus(id);
      if (!id) return;
      tab.value = 'chat';
      await loadAgentData();
    };

    onMounted(async () => {
      await loadAgents();
      try {
        const { createOffice } = await import('../office3d.js');
        office = createOffice(stage.value, agents.value, { onSelect: select, companyName: store.company });
        office.update(agents.value);
      } catch (e) {
        console.warn('3D indisponible', e);
        view3d.value = false;
      }
      poll = setInterval(loadAgents, 5000);
      if (route.query.agent) {
        await select(route.query.agent);
        if (route.query.ask) input.value = route.query.ask;
      }
    });
    onUnmounted(() => { clearInterval(poll); office?.dispose(); });

    const send = async (text) => {
      const msg = (text || input.value).trim();
      if (!msg || sending.value) return;
      const id = selected.value;
      input.value = '';
      messages.value.push({ role: 'user', content: msg });
      sending.value = true;
      scrollDown();
      office?.update(agents.value.map((a) => (a.id === id ? { ...a, working: true } : a)));
      try {
        const r = await POST(`/agents/${id}/chat`, { message: msg });
        if (selected.value === id) messages.value.push({ role: 'assistant', content: r.reply });
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        sending.value = false;
        scrollDown();
        loadAgents();
      }
    };
    const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    const clearChat = async () => { if (!confirm('Effacer la conversation ?')) return; await DEL(`/agents/${selected.value}/messages`); messages.value = []; };
    const copy = (t) => { navigator.clipboard?.writeText(t); toast('Copié'); };

    const newTask = (tpl) => { taskEdit.value = { agent_id: selected.value, schedule_type: 'weekly', schedule_time: '08:00', schedule_day: 1, title: '', prompt: '', ...(tpl || {}) }; };
    const saveTask = async () => {
      const t = taskEdit.value;
      if (t.id) await act(() => PUT('/agent-tasks/' + t.id, t), 'Tâche modifiée'); else await act(() => POST('/agent-tasks', t), 'Tâche programmée');
      taskEdit.value = null; loadAgentData(); loadAgents();
    };
    const toggleTask = async (t) => { await act(() => PUT('/agent-tasks/' + t.id, { active: t.active ? 0 : 1 })); loadAgentData(); };
    const deleteTask = async (t) => { if (!confirm('Supprimer cette tâche ?')) return; await act(() => DEL('/agent-tasks/' + t.id)); loadAgentData(); loadAgents(); };
    const runTask = async (t) => {
      toast(`${agent.value.name} commence : ${t.title}`);
      office?.update(agents.value.map((a) => (a.id === t.agent_id ? { ...a, working: true } : a)));
      await act(() => POST(`/agent-tasks/${t.id}/run`), 'Tâche terminée — rapport disponible');
      tab.value = 'results';
      loadAgentData(); loadAgents();
    };
    const openResult = async (r, e) => {
      if (e.target.open && !r.read) { await POST(`/agent-results/${r.id}/read`); r.read = 1; loadAgents(); }
    };
    const deleteResult = async (r) => { await DEL('/agent-results/' + r.id); loadAgentData(); };
    const describe = (t) => {
      if (t.schedule_type === 'once') return `Une fois — ${datetime(t.run_at || t.next_run)}`;
      const base = { daily: 'Chaque jour', weekdays: 'Lun-ven', weekly: `Chaque ${DAYS[t.schedule_day]?.toLowerCase()}`, monthly: `Le ${t.schedule_day} du mois` }[t.schedule_type];
      return `${base} à ${t.schedule_time}`;
    };

    const runMeeting = async () => {
      if (!meeting.question.trim()) return;
      meeting.running = true;
      meeting.content = '';
      office?.update(agents.value.map((a) => ({ ...a, working: true })));
      try {
        const r = await POST('/agents/meeting', { question: meeting.question });
        meeting.content = r.content;
      } catch (e) { toast(e.message, 'error'); }
      meeting.running = false;
      loadAgents();
    };

    return { agents, selected, agent, select, tab, messages, input, sending, send, onKey, clearChat, copy, md, stage, chatBox, view3d,
      tasks, results, taskEdit, newTask, saveTask, toggleTask, deleteTask, runTask, openResult, deleteResult, describe, meeting, runMeeting,
      SUGGESTIONS, SCHEDULES, DAYS, TEMPLATES, datetime, store };
  },
  template: `
  <div>
    <div class="office" v-show="view3d">
      <div ref="stage" style="position:absolute;inset:0"></div>
      <div class="office-hud">
        <div class="title"><b>🏢 Bureau virtuel</b><small>Cliquez sur un collaborateur pour lui parler ou lui confier une tâche</small></div>
        <div class="btns">
          <button class="btn" @click="meeting.open = true">👥 Réunion d'équipe</button>
          <button class="btn" @click="select(null)">🎥 Vue d'ensemble</button>
          <button class="btn" @click="view3d = false">☰ Vue liste</button>
        </div>
      </div>
      <div v-if="!store.ai && !agent" style="position:absolute;bottom:14px;left:14px;right:14px;pointer-events:none"><div class="error" style="display:inline-block;pointer-events:auto">Mode démo : ajoutez votre clé ANTHROPIC_API_KEY dans le fichier .env pour activer les agents.</div></div>
      <div v-if="agent" class="agent-panel">
        <div class="agent-head" :style="{background: agent.color}">
          <div class="emoji">{{ agent.emoji }}</div>
          <div style="flex:1"><b style="font-size:16px">{{ agent.name }}</b><div style="opacity:.9">{{ agent.role }}</div></div>
          <button class="icon-btn" style="color:#fff" @click="select(null)">✕</button>
        </div>
        <div class="tabs">
          <button :class="{active: tab==='chat'}" @click="tab='chat'">💬 Discussion</button>
          <button :class="{active: tab==='tasks'}" @click="tab='tasks'">⏰ Tâches ({{ tasks.length }})</button>
          <button :class="{active: tab==='results'}" @click="tab='results'">📄 Rapports <span v-if="agent.unread" class="badge b-red">{{ agent.unread }}</span></button>
        </div>
        <template v-if="tab==='chat'">
          <div class="agent-body" ref="chatBox">
            <div class="msg assistant"><div class="md">{{ agent.intro }}</div>
              <div class="suggest"><button v-for="s in SUGGESTIONS[agent.id]" @click="send(s)">{{ s }}</button></div></div>
            <div v-for="m in messages" class="msg" :class="m.role">
              <div v-if="m.role === 'assistant'" class="md" v-html="md(m.content)"></div><template v-else>{{ m.content }}</template>
              <div v-if="m.role === 'assistant'" style="text-align:right"><button class="link small" @click="copy(m.content)">Copier</button></div>
            </div>
            <div v-if="sending" class="msg assistant"><span class="typing"><span></span><span></span><span></span></span> <span class="muted small">{{ agent.name }} consulte vos données…</span></div>
          </div>
          <div class="chat-input">
            <textarea v-model="input" @keydown="onKey" :placeholder="'Demandez quelque chose à ' + agent.name + '…'" rows="1"></textarea>
            <div style="display:flex;flex-direction:column;gap:4px"><button class="btn primary" :disabled="sending || !input.trim()" @click="send()">➤</button><button class="icon-btn small" title="Effacer" @click="clearChat">🗑</button></div>
          </div>
        </template>
        <div v-else-if="tab==='tasks'" class="agent-body">
          <div class="btns" style="margin-bottom:12px"><button class="btn primary" @click="newTask()">+ Programmer une tâche</button><button class="btn" @click="newTask(TEMPLATES[agent.id])">✨ Modèle : {{ TEMPLATES[agent.id].title }}</button></div>
          <div v-for="t in tasks" class="task">
            <div style="display:flex;justify-content:space-between;gap:8px"><b>{{ t.title }}</b><Badge :label="t.active ? 'Active' : 'En pause'" :color="t.active ? 'green' : 'gray'"/></div>
            <div class="muted small">🔁 {{ describe(t) }} <span v-if="t.next_run && t.active">· prochaine : {{ datetime(t.next_run) }}</span></div>
            <div class="small" style="margin:6px 0;white-space:pre-wrap">{{ t.prompt }}</div>
            <div class="muted small" v-if="t.last_run">Dernière exécution : {{ datetime(t.last_run) }} <Badge :status="t.last_status === 'ok' ? 'done' : t.last_status" :label="t.last_status === 'ok' ? 'OK' : t.last_status === 'running' ? 'en cours' : 'erreur'" :color="t.last_status === 'ok' ? 'green' : t.last_status === 'running' ? 'blue' : 'red'"/></div>
            <div class="btns" style="margin-top:8px"><button class="btn sm primary" @click="runTask(t)">▶ Exécuter maintenant</button><button class="btn sm" @click="taskEdit = {...t}">✎</button><button class="btn sm" @click="toggleTask(t)">{{ t.active ? '⏸ Pause' : '▶ Activer' }}</button><button class="btn sm danger" @click="deleteTask(t)">🗑</button></div>
          </div>
          <Empty v-if="!tasks.length" icon="⏰" :text="'Programmez des tâches récurrentes : ' + agent.name + ' travaillera pour vous automatiquement et déposera ses rapports ici.'"/>
        </div>
        <div v-else class="agent-body">
          <details v-for="r in results" class="result" :class="{unread: !r.read}" @toggle="openResult(r, $event)">
            <summary><span>{{ r.title }}</span><span class="muted small nowrap">{{ datetime(r.created_at.replace(' ', 'T') + 'Z') }}</span></summary>
            <div class="md" v-html="md(r.content)"></div>
            <div class="btns" style="padding:0 12px 12px"><button class="btn sm" @click="copy(r.content)">Copier</button><button class="btn sm danger" @click="deleteResult(r)">Supprimer</button></div>
          </details>
          <Empty v-if="!results.length" icon="📄" text="Les rapports des tâches programmées apparaîtront ici."/>
        </div>
      </div>
    </div>

    <div v-if="!view3d">
      <div class="page-head"><div><h1>🤖 Votre équipe IA</h1><div class="sub">6 experts disponibles 24h/24</div></div><div class="btns"><button class="btn" @click="meeting.open = true">👥 Réunion d'équipe</button><button class="btn" @click="view3d = true; $nextTick(() => select(null))">🏢 Vue 3D</button></div></div>
      <div class="grid g3">
        <div v-for="a in agents" class="card" style="cursor:pointer" @click="view3d = true; $nextTick(() => select(a.id))">
          <div style="display:flex;gap:12px;align-items:center"><div class="avatar" :style="{background: a.color, width: '48px', height: '48px', fontSize: '24px'}">{{ a.emoji }}</div>
            <div><b>{{ a.name }}</b> <span v-if="a.working" class="live">travaille</span><div class="muted">{{ a.role }}</div></div></div>
          <p class="small muted">{{ a.intro }}</p>
          <div class="small">⏰ {{ a.tasks }} tâche(s) · 📄 {{ a.unread }} rapport(s) non lu(s)</div>
        </div>
      </div>
    </div>

    <Modal v-if="taskEdit" :title="taskEdit.id ? 'Modifier la tâche' : 'Programmer une tâche'" @close="taskEdit = null">
      <label>Titre<input v-model="taskEdit.title" placeholder="Ex. : Point trésorerie du lundi"></label>
      <label>Consigne pour l'agent<textarea v-model="taskEdit.prompt" rows="5" placeholder="Décrivez précisément ce que vous attendez…"></textarea></label>
      <div class="form-grid">
        <label>Fréquence<select v-model="taskEdit.schedule_type"><option v-for="(l, k) in SCHEDULES" :value="k">{{ l }}</option></select></label>
        <label v-if="taskEdit.schedule_type === 'once'">Date et heure<input type="datetime-local" v-model="taskEdit.run_at"></label>
        <label v-else>Heure<input type="time" v-model="taskEdit.schedule_time"></label>
        <label v-if="taskEdit.schedule_type === 'weekly'">Jour<select v-model.number="taskEdit.schedule_day"><option v-for="(d, i) in DAYS" :value="i">{{ d }}</option></select></label>
        <label v-if="taskEdit.schedule_type === 'monthly'">Jour du mois<input type="number" min="1" max="28" v-model.number="taskEdit.schedule_day"></label>
      </div>
      <template #foot><button class="btn" @click="taskEdit = null">Annuler</button><button class="btn primary" :disabled="!taskEdit.title || !taskEdit.prompt" @click="saveTask">Enregistrer</button></template>
    </Modal>

    <Modal v-if="meeting.open" title="👥 Réunion d'équipe" wide @close="meeting.open = false">
      <p class="muted">Posez une question à toute l'équipe : chaque expert donne son avis, puis Alex (CIO) fait la synthèse et propose un plan d'action.</p>
      <textarea v-model="meeting.question" placeholder="Ex. : Dois-je embaucher un 5e mécanicien l'année prochaine ?"></textarea>
      <div class="btns"><button class="btn primary" :disabled="meeting.running || !meeting.question.trim()" @click="runMeeting">{{ meeting.running ? 'Réunion en cours…' : 'Lancer la réunion' }}</button>
        <span v-if="meeting.running" class="typing"><span></span><span></span><span></span></span></div>
      <div v-if="meeting.content" class="md" v-html="md(meeting.content)" style="border-top:1px solid var(--line);padding-top:12px"></div>
    </Modal>
  </div>`,
};
