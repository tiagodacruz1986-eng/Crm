// Bureau IA « Neural Core » : parler (voix) ou écrire aux agents, consulter l'historique des conversations,
// programmer des tâches et lire les rapports.
import { ref, reactive, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { GET, POST, PUT, DEL, act, toast, datetime, store } from '../api.js';
import { route } from '../router.js';
import { speak, stopSpeaking, createRecognizer, voiceSupported } from '../copilot.js';

const md = (s) => DOMPurify.sanitize(marked.parse(s || ''));

const SUGGESTIONS = {
  comptable: ['Fais le point sur ma trésorerie et mes impayés', 'Prépare mon décompte de TVA du trimestre', 'Quelle est ma marge sur les pièces vs la main-d\'œuvre ?'],
  marketing: ['Crée une campagne pneus hiver pour Facebook et Instagram', 'Liste les clients à relancer pour le contrôle technique', 'Propose 5 idées pour avoir plus d\'avis Google'],
  secretariat: ['Résume-moi les rendez-vous de la semaine', 'Rédige les relances pour les factures en retard', 'Écris un e-mail de confirmation de rendez-vous type'],
  atelier: ['Quelle est la productivité de l\'atelier cette semaine ?', 'Quels OR sont en retard ou dépassent le temps vendu ?', 'Quelles pièces dois-je commander ?'],
  avocat: ['Un client refuse de payer une réparation, que faire ?', 'Ai-je un droit de rétention sur le véhicule ?', 'Quelles mentions obligatoires sur mes factures au Luxembourg ?'],
  cio: ['Où sera mon garage dans 5 ans ? Fais-moi une feuille de route', 'Dois-je investir dans l\'entretien des véhicules électriques ?', 'Quels outils digitaux mettre en place en priorité ?'],
};
// Une voix différente pour chaque agent
const VOICES = { comptable: { voice: 0, pitch: 1.1 }, marketing: { voice: 1, pitch: 1.2 }, secretariat: { voice: 2, pitch: 1.15 }, atelier: { voice: 1, pitch: 0.85 }, avocat: { voice: 0, pitch: 0.8 }, cio: { voice: 2, pitch: 0.95 } };
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
const sqlDate = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z') : null);
const ago = (s) => {
  const d = sqlDate(s);
  if (!d) return '';
  const min = Math.round((Date.now() - d) / 60000);
  if (min < 1) return 'à l\'instant';
  if (min < 60) return `il y a ${min} min`;
  if (min < 60 * 24 && d.getDate() === new Date().getDate()) return `aujourd'hui ${d.toLocaleTimeString('fr-LU', { hour: '2-digit', minute: '2-digit' })}`;
  if (min < 60 * 48) return `hier ${d.toLocaleTimeString('fr-LU', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('fr-LU', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};
const pref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } };
const savePref = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* navigation privée */ } };

export const Office = {
  setup() {
    const agents = ref([]);
    const selected = ref(null);
    const tab = ref('chat');
    const messages = ref([]);
    const conv = reactive({ id: null, title: '' });
    const convs = ref([]);
    const convQ = ref('');
    const input = ref('');
    const sending = ref(false);
    const tasks = ref([]);
    const results = ref([]);
    const taskEdit = ref(null);
    const meeting = reactive({ open: false, question: '', running: false, content: '' });
    const history = reactive({ open: false, q: '', items: [], loading: false });
    const view3d = ref(true);
    const stage = ref(null);
    const chatBox = ref(null);
    // Voix
    const voiceOn = ref(pref('office_voice', true));
    const handsFree = ref(false);
    const listening = ref(false);
    const speaking = ref(false);
    const interim = ref('');
    let rec = null;
    let office = null;
    let poll;
    let levelTimer = null;
    let level = 0;

    const agent = computed(() => agents.value.find((a) => a.id === selected.value));
    const activeCount = computed(() => agents.value.filter((a) => a.working).length);
    const setActivity = (mode) => office?.setActivity(selected.value, mode);
    const loadAgents = async () => {
      agents.value = await GET('/agents');
      office?.update(agents.value);
    };
    const scrollDown = () => nextTick(() => { if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight; });

    // ---------- Conversations ----------
    const loadConvs = async () => {
      if (!selected.value) return;
      convs.value = await GET(`/agent-conversations?agent=${selected.value}${convQ.value.trim() ? '&q=' + encodeURIComponent(convQ.value.trim()) : ''}`);
    };
    const openConv = async (id) => {
      const c = await GET('/agent-conversations/' + id);
      if (c.agent_id !== selected.value) await select(c.agent_id, { keepConv: true });
      conv.id = c.id; conv.title = c.title;
      messages.value = c.messages;
      tab.value = 'chat';
      scrollDown();
    };
    const newConv = () => { stopVoice(); conv.id = null; conv.title = ''; messages.value = []; tab.value = 'chat'; };
    const renameConv = async (c) => {
      const t = prompt('Nouveau titre de la conversation', c.title);
      if (!t?.trim()) return;
      await PUT('/agent-conversations/' + c.id, { title: t.trim() });
      if (conv.id === c.id) conv.title = t.trim();
      loadConvs(); if (history.open) searchHistory();
    };
    const pinConv = async (c) => { await PUT('/agent-conversations/' + c.id, { pinned: !c.pinned }); loadConvs(); };
    const deleteConv = async (c) => {
      if (!confirm(`Supprimer la conversation « ${c.title} » ?`)) return;
      await DEL('/agent-conversations/' + c.id);
      if (conv.id === c.id) newConv();
      loadConvs(); if (history.open) searchHistory();
    };
    let convTimer;
    watch(convQ, () => { clearTimeout(convTimer); convTimer = setTimeout(loadConvs, 250); });

    // Historique de toute l'équipe
    const searchHistory = async () => {
      history.loading = true;
      history.items = await GET('/agent-conversations?limit=150' + (history.q.trim() ? '&q=' + encodeURIComponent(history.q.trim()) : ''));
      history.loading = false;
    };
    let histTimer;
    watch(() => history.q, () => { clearTimeout(histTimer); histTimer = setTimeout(searchHistory, 250); });
    const openHistory = () => { history.open = true; searchHistory(); };
    const fromHistory = async (c) => { history.open = false; view3d.value = true; await nextTick(); await openConv(c.id); };

    const select = async (id, { keepConv = false } = {}) => {
      stopVoice();
      selected.value = id;
      office?.focus(id);
      if (!id) return;
      tab.value = 'chat';
      convQ.value = '';
      [tasks.value, results.value] = await Promise.all([GET(`/agent-tasks?agent=${id}`), GET(`/agent-results?agent=${id}`)]);
      await loadConvs();
      if (keepConv) return;
      // Reprend la dernière conversation si elle date de moins de 12 h, sinon nouvelle conversation
      const last = convs.value.find((c) => !c.pinned) || convs.value[0];
      if (last && Date.now() - sqlDate(last.updated_at) < 12 * 3600e3) await openConv(last.id); else newConv();
    };

    // ---------- Envoi ----------
    const send = async (text) => {
      const msg = (text ?? input.value).trim();
      if (!msg || sending.value) return;
      const id = selected.value;
      input.value = '';
      stopSpeaking();
      messages.value.push({ role: 'user', content: msg });
      sending.value = true;
      setActivity('thinking');
      scrollDown();
      try {
        const r = await POST(`/agents/${id}/chat`, { message: msg, conversation_id: conv.id });
        if (selected.value !== id) return;
        if (!conv.id) { conv.id = r.conversation_id; conv.title = msg.length > 70 ? msg.slice(0, 67) + '…' : msg; }
        messages.value.push({ role: 'assistant', content: r.reply });
        loadConvs();
        if (voiceOn.value && !r.reply.startsWith('❌')) say(r.reply); else { setActivity(null); if (handsFree.value) listen(); }
      } catch (e) {
        toast(e.message, 'error');
        setActivity(null);
      } finally {
        sending.value = false;
        scrollDown();
        loadAgents();
      }
    };
    const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    const copy = (t) => { navigator.clipboard?.writeText(t); toast('Copié'); };

    // ---------- Voix ----------
    const startLevel = () => {
      clearInterval(levelTimer);
      levelTimer = setInterval(() => { level *= 0.82; office?.setLevel(level); }, 60);
    };
    const say = (text) => {
      const id = selected.value;
      speak(text, {
        ...(VOICES[id] || {}),
        onStart: () => { speaking.value = true; setActivity('speaking'); startLevel(); },
        onBoundary: () => { level = 1; },
        onEnd: () => {
          speaking.value = false; clearInterval(levelTimer); office?.setLevel(0);
          if (selected.value === id) { setActivity(null); if (handsFree.value) setTimeout(listen, 250); }
        },
      });
    };
    const listen = () => {
      if (!voiceSupported) return toast('La voix nécessite Chrome, Edge ou Safari', 'error');
      if (listening.value || sending.value || !selected.value) return;
      stopSpeaking();
      let said = '';
      rec = createRecognizer({
        continuous: false,
        onText: (t) => { said += ' ' + t; level = 1; },
        onInterim: (t) => { interim.value = t; level = Math.min(1, level + 0.35); },
        onError: (err) => { if (err === 'not-allowed') handsFree.value = false; },
        onEnd: () => {
          listening.value = false; interim.value = ''; clearInterval(levelTimer); office?.setLevel(0);
          if (said.trim()) send(said.trim());
          else { setActivity(null); if (handsFree.value && selected.value) setTimeout(listen, 400); }
        },
      });
      listening.value = true;
      setActivity('listening');
      startLevel();
      try { rec.start(); } catch { listening.value = false; setActivity(null); }
    };
    const talk = () => { if (listening.value) rec?.stop(); else listen(); };
    function stopVoice() {
      handsFree.value = false;
      if (listening.value) { rec?.abort?.(); listening.value = false; }
      stopSpeaking(); speaking.value = false; interim.value = '';
      clearInterval(levelTimer);
      office?.setLevel(0);
      if (selected.value) office?.setActivity(selected.value, null);
    }
    const toggleHandsFree = () => {
      if (handsFree.value) { stopVoice(); return; }
      if (!voiceSupported) return toast('Le mode conversation nécessite Chrome, Edge ou Safari', 'error');
      handsFree.value = true;
      voiceOn.value = true;
      toast(`🎙️ Mode conversation : parlez à ${agent.value?.name}, il vous répond à voix haute`);
      listen();
    };
    const toggleVoice = () => { voiceOn.value = !voiceOn.value; savePref('office_voice', voiceOn.value); if (!voiceOn.value) { stopSpeaking(); speaking.value = false; setActivity(null); } };
    const replay = (m) => say(m.content);

    // ---------- Tâches et rapports ----------
    const loadTasks = async () => { [tasks.value, results.value] = await Promise.all([GET(`/agent-tasks?agent=${selected.value}`), GET(`/agent-results?agent=${selected.value}`)]); };
    const newTask = (tpl) => { taskEdit.value = { agent_id: selected.value, schedule_type: 'weekly', schedule_time: '08:00', schedule_day: 1, title: '', prompt: '', ...(tpl || {}) }; };
    const saveTask = async () => {
      const t = taskEdit.value;
      if (t.id) await act(() => PUT('/agent-tasks/' + t.id, t), 'Tâche modifiée'); else await act(() => POST('/agent-tasks', t), 'Tâche programmée');
      taskEdit.value = null; loadTasks(); loadAgents();
    };
    const toggleTask = async (t) => { await act(() => PUT('/agent-tasks/' + t.id, { active: t.active ? 0 : 1 })); loadTasks(); };
    const deleteTask = async (t) => { if (!confirm('Supprimer cette tâche ?')) return; await act(() => DEL('/agent-tasks/' + t.id)); loadTasks(); loadAgents(); };
    const runTask = async (t) => {
      toast(`${agent.value.name} commence : ${t.title}`);
      office?.update(agents.value.map((a) => (a.id === t.agent_id ? { ...a, working: true } : a)));
      await act(() => POST(`/agent-tasks/${t.id}/run`), 'Tâche terminée — rapport disponible');
      tab.value = 'results';
      loadTasks(); loadAgents();
    };
    const openResult = async (r, e) => {
      if (e.target.open && !r.read) { await POST(`/agent-results/${r.id}/read`); r.read = 1; loadAgents(); }
    };
    const deleteResult = async (r) => { await DEL('/agent-results/' + r.id); loadTasks(); };
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

    onMounted(async () => {
      await loadAgents();
      try {
        const { createOffice } = await import('../office3d.js');
        office = createOffice(stage.value, agents.value, { onSelect: select });
        office.update(agents.value);
      } catch (e) {
        console.warn('3D indisponible', e);
        view3d.value = false;
      }
      poll = setInterval(loadAgents, 5000);
      if (route.query.conv) await openConv(Number(route.query.conv));
      else if (route.query.agent) {
        await select(route.query.agent);
        if (route.query.ask) { newConv(); input.value = route.query.ask; }
      }
    });
    onUnmounted(() => { stopVoice(); clearInterval(poll); office?.dispose(); });

    return { agents, selected, agent, activeCount, select, tab, messages, conv, convs, convQ, openConv, newConv, renameConv, pinConv, deleteConv,
      history, openHistory, fromHistory, input, sending, send, onKey, copy, md, stage, chatBox, view3d,
      voiceOn, handsFree, listening, speaking, interim, talk, toggleHandsFree, toggleVoice, replay, voiceSupported,
      tasks, results, taskEdit, newTask, saveTask, toggleTask, deleteTask, runTask, openResult, deleteResult, describe, meeting, runMeeting,
      SUGGESTIONS, SCHEDULES, DAYS, TEMPLATES, datetime, ago, store };
  },
  template: `
  <div>
    <div class="office neural" v-show="view3d" :class="{ 'has-panel': agent }">
      <div ref="stage" style="position:absolute;inset:0"></div>
      <div class="office-hud">
        <div class="title">
          <span class="core-dot"></span>
          <div><b>Neural Core</b><small>{{ agents.length }} agents IA · <template v-if="activeCount">{{ activeCount }} au travail</template><template v-else>en ligne</template></small></div>
        </div>
        <div class="btns">
          <button class="btn glass" @click="openHistory"><Icon name="history"/> <span class="lbl">Historique</span></button>
          <button class="btn glass" @click="meeting.open = true"><Icon name="users"/> <span class="lbl">Réunion</span></button>
          <button class="btn glass" v-if="agent" @click="select(null)"><Icon name="scan"/> <span class="lbl">Vue d'ensemble</span></button>
          <button class="btn glass" @click="view3d = false"><Icon name="list"/></button>
        </div>
      </div>

      <div class="agent-dock" v-if="!agent">
        <button v-for="a in agents" :key="a.id" class="dock-item" :style="{'--c': a.color}" @click="select(a.id)">
          <span class="orb">{{ a.emoji }}</span><span class="nm">{{ a.name }}<small>{{ a.role }}</small></span>
          <span v-if="a.unread" class="dot">{{ a.unread }}</span><span v-if="a.working" class="live-dot"></span>
        </button>
      </div>
      <div v-if="!store.ai && !agent" class="demo-note">Mode démo : ajoutez votre clé ANTHROPIC_API_KEY dans le fichier .env pour activer les agents.</div>

      <aside v-if="agent" class="agent-panel console" :style="{'--c': agent.color}">
        <div class="agent-head">
          <div class="av" :class="{ pulse: listening || speaking || sending }"><span>{{ agent.emoji }}</span></div>
          <div style="flex:1;min-width:0"><b>{{ agent.name }}</b>
            <div class="st"><template v-if="listening">🎙️ vous écoute…</template><template v-else-if="sending">💭 consulte vos données…</template><template v-else-if="speaking">🔊 vous répond…</template><template v-else>{{ agent.role }}</template></div></div>
          <button class="icon-btn" :class="{ on: voiceOn }" @click="toggleVoice" :title="voiceOn ? 'Réponses à voix haute : activées' : 'Réponses à voix haute : désactivées'"><Icon :name="voiceOn ? 'volume-2' : 'volume-x'"/></button>
          <button class="icon-btn" @click="select(null)" title="Fermer"><Icon name="x"/></button>
        </div>
        <div class="tabs">
          <button :class="{active: tab==='chat'}" @click="tab='chat'"><Icon name="message-circle"/> Discussion</button>
          <button :class="{active: tab==='history'}" @click="tab='history'"><Icon name="history"/> Historique <span class="count">{{ convs.length }}</span></button>
          <button :class="{active: tab==='tasks'}" @click="tab='tasks'"><Icon name="alarm-clock"/> Tâches <span class="count">{{ tasks.length }}</span></button>
          <button :class="{active: tab==='results'}" @click="tab='results'"><Icon name="file-text"/> Rapports <span v-if="agent.unread" class="badge b-red">{{ agent.unread }}</span></button>
        </div>

        <template v-if="tab==='chat'">
          <div class="conv-bar">
            <span class="ttl">{{ conv.id ? conv.title : 'Nouvelle conversation' }}</span>
            <button class="btn sm" @click="newConv"><Icon name="plus"/> Nouvelle</button>
          </div>
          <div class="agent-body" ref="chatBox">
            <div v-if="!messages.length" class="msg assistant"><div class="md">{{ agent.intro }}</div>
              <div class="suggest"><button v-for="s in SUGGESTIONS[agent.id]" @click="send(s)">{{ s }}</button></div></div>
            <div v-for="m in messages" class="msg" :class="m.role">
              <div v-if="m.role === 'assistant'" class="md" v-html="md(m.content)"></div><template v-else>{{ m.content }}</template>
              <div class="meta"><span v-if="m.created_at">{{ ago(m.created_at) }}</span>
                <template v-if="m.role === 'assistant'"><button class="link small" @click="replay(m)"><Icon name="volume-2"/> Écouter</button><button class="link small" @click="copy(m.content)">Copier</button></template></div>
            </div>
            <div v-if="sending" class="msg assistant"><span class="typing"><span></span><span></span><span></span></span> <span class="muted small">{{ agent.name }} consulte vos données…</span></div>
          </div>
          <div v-if="listening || interim" class="voice-live"><span class="wave"><i></i><i></i><i></i><i></i><i></i></span>{{ interim || 'Parlez, je vous écoute…' }}</div>
          <div class="chat-input">
            <button class="mic-btn" :class="{ on: listening }" @click="talk" :disabled="sending" :title="voiceSupported ? 'Appuyez et parlez' : 'Voix non disponible dans ce navigateur'"><Icon :name="listening ? 'square' : 'mic'"/></button>
            <textarea v-model="input" @keydown="onKey" :placeholder="'Écrivez ou parlez à ' + agent.name + '…'" rows="1"></textarea>
            <button class="btn primary send" :disabled="sending || !input.trim()" @click="send()"><Icon name="send"/></button>
          </div>
          <div class="handsfree">
            <button class="hf-btn" :class="{ on: handsFree }" @click="toggleHandsFree"><Icon :name="handsFree ? 'phone-off' : 'audio-lines'"/> {{ handsFree ? 'Terminer la conversation vocale' : 'Mode conversation vocale' }}</button>
          </div>
        </template>

        <div v-else-if="tab==='history'" class="agent-body">
          <div class="search-field"><Icon name="search"/><input v-model="convQ" placeholder="Rechercher dans les conversations…"></div>
          <div v-for="c in convs" :key="c.id" class="conv-item" :class="{ current: c.id === conv.id }" @click="openConv(c.id)">
            <div class="top"><b><Icon v-if="c.pinned" name="pin"/> {{ c.title }}</b><span class="muted small nowrap">{{ ago(c.updated_at) }}</span></div>
            <div class="muted small prev">{{ c.last }}</div>
            <div class="acts" @click.stop><span class="muted small">{{ c.messages }} message(s)</span>
              <button class="link small" @click="pinConv(c)">{{ c.pinned ? 'Désépingler' : 'Épingler' }}</button><button class="link small" @click="renameConv(c)">Renommer</button><button class="link small danger" @click="deleteConv(c)">Supprimer</button></div>
          </div>
          <Empty v-if="!convs.length" icon="💬" :text="convQ ? 'Aucune conversation ne correspond.' : 'Vos conversations avec ' + agent.name + ' seront rangées ici.'"/>
        </div>

        <div v-else-if="tab==='tasks'" class="agent-body">
          <div class="btns" style="margin-bottom:12px"><button class="btn primary" @click="newTask()">+ Programmer une tâche</button><button class="btn" @click="newTask(TEMPLATES[agent.id])">✨ Modèle : {{ TEMPLATES[agent.id].title }}</button></div>
          <div v-for="t in tasks" class="task">
            <div style="display:flex;justify-content:space-between;gap:8px"><b>{{ t.title }}</b><Badge :label="t.active ? 'Active' : 'En pause'" :color="t.active ? 'green' : 'gray'"/></div>
            <div class="muted small">🔁 {{ describe(t) }} <span v-if="t.next_run && t.active">· prochaine : {{ datetime(t.next_run) }}</span></div>
            <div class="small" style="margin:6px 0;white-space:pre-wrap">{{ t.prompt }}</div>
            <div class="muted small" v-if="t.last_run">Dernière exécution : {{ datetime(t.last_run) }} <Badge :label="t.last_status === 'ok' ? 'OK' : t.last_status === 'running' ? 'en cours' : 'erreur'" :color="t.last_status === 'ok' ? 'green' : t.last_status === 'running' ? 'blue' : 'red'"/></div>
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
      </aside>
    </div>

    <div v-if="!view3d">
      <div class="page-head"><div><h1>🤖 Votre équipe IA</h1><div class="sub">6 experts disponibles 24h/24</div></div><div class="btns"><ModuleTools module="ia"/><button class="btn" @click="openHistory"><Icon name="history"/> Historique</button><button class="btn" @click="meeting.open = true">👥 Réunion d'équipe</button><button class="btn" @click="view3d = true; $nextTick(() => select(null))">🧠 Neural Core</button></div></div>
      <div class="grid g3">
        <div v-for="a in agents" class="card" style="cursor:pointer" @click="view3d = true; $nextTick(() => select(a.id))">
          <div style="display:flex;gap:12px;align-items:center"><div class="avatar" :style="{background: a.color, width: '48px', height: '48px', fontSize: '24px'}">{{ a.emoji }}</div>
            <div><b>{{ a.name }}</b> <span v-if="a.working" class="live">travaille</span><div class="muted">{{ a.role }}</div></div></div>
          <p class="small muted">{{ a.intro }}</p>
          <div class="small">⏰ {{ a.tasks }} tâche(s) · 📄 {{ a.unread }} rapport(s) non lu(s)</div>
        </div>
      </div>
    </div>

    <Modal v-if="history.open" title="Historique des conversations" wide @close="history.open = false">
      <div class="search-field"><Icon name="search"/><input v-model="history.q" placeholder="Rechercher un mot, un client, une plaque… dans toutes les conversations"></div>
      <div class="hist-list">
        <div v-for="c in history.items" :key="c.id" class="conv-item" @click="fromHistory(c)">
          <div class="top"><span class="who" :style="{'--c': c.agent_color}">{{ c.agent_emoji }} {{ c.agent_name }}</span><b>{{ c.title }}</b><span class="muted small nowrap">{{ ago(c.updated_at) }}</span></div>
          <div class="muted small prev">{{ c.last }}</div>
        </div>
        <Empty v-if="!history.items.length && !history.loading" icon="💬" :text="history.q ? 'Aucun résultat.' : 'Aucune conversation pour le moment. Cliquez sur un agent pour lui parler.'"/>
      </div>
    </Modal>

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
