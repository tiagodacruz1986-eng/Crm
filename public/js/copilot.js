// Nova — copilote IA : orbe flottant, voix (reconnaissance + synthèse vocale), journal, résumé de fin de journée.
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { GET, POST, PUT, DEL, act, toast, store, date as fdate, datetime } from './api.js';

const md = (s) => DOMPurify.sanitize(marked.parse(s || ''));
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const voiceSupported = Boolean(SR);

// Lecture à voix haute (sans le Markdown). `opts` : { pitch, rate, voice (index parmi les voix françaises), onStart, onEnd, onBoundary }
export function speak(text, opts = {}) {
  if (!('speechSynthesis' in window) || !text) { opts.onEnd?.(); return; }
  speechSynthesis.cancel();
  const clean = text.replace(/[#*_`>|]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/\p{Extended_Pictographic}/gu, '').replace(/\n+/g, '. ').slice(0, 1500);
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'fr-FR';
  u.rate = opts.rate ?? 1.05;
  u.pitch = opts.pitch ?? 1;
  const fr = speechSynthesis.getVoices().filter((x) => x.lang?.startsWith('fr'));
  const nice = fr.filter((x) => /Google|Amélie|Thomas|Denise|Hortense|Henri|Eloise|Premium|Enhanced|Natural/i.test(x.name));
  const pool = nice.length ? nice : fr;
  const v = opts.voice != null && pool.length ? pool[opts.voice % pool.length] : pool[0];
  if (v) u.voice = v;
  u.onstart = () => opts.onStart?.();
  u.onend = () => opts.onEnd?.();
  u.onerror = () => opts.onEnd?.();
  u.onboundary = () => opts.onBoundary?.();
  speechSynthesis.speak(u);
}
export const stopSpeaking = () => { try { speechSynthesis.cancel(); } catch { /* indisponible */ } };

// Reconnaissance vocale : une phrase (commande) ou écoute continue (journal)
export function createRecognizer({ continuous, onText, onInterim, onEnd, onError }) {
  const r = new SR();
  r.lang = 'fr-FR';
  r.continuous = continuous;
  r.interimResults = true;
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) onText(t.trim()); else interim += t;
    }
    onInterim?.(interim);
  };
  r.onerror = (e) => { if (e.error === 'not-allowed') toast('Autorisez le micro dans le navigateur pour parler', 'error'); onError?.(e.error); };
  r.onend = () => onEnd?.();
  return r;
}

export const Copilot = {
  setup() {
    const open = ref(false);
    const messages = ref([]);
    const input = ref('');
    const busy = ref(false);
    const listening = ref(false);
    const ambient = ref(false);
    const interim = ref('');
    const voiceOn = ref((() => { try { return localStorage.getItem('nova_voice') !== '0'; } catch { return true; } })());
    const body = ref(null);
    let rec = null, ambientRec = null;

    const scroll = () => nextTick(() => { if (body.value) body.value.scrollTop = body.value.scrollHeight; });
    const send = async (text) => {
      const msg = (text ?? input.value).trim();
      if (!msg || busy.value) return;
      input.value = '';
      const history = messages.value.map(({ role, content }) => ({ role, content }));
      messages.value.push({ role: 'user', content: msg });
      busy.value = true; scroll();
      try {
        const r = await POST('/copilot/chat', { message: msg, history });
        messages.value.push({ role: 'assistant', content: r.reply, actions: r.actions });
        if (voiceOn.value) speak(r.reply);
      } catch (e) {
        messages.value.push({ role: 'assistant', content: `⚠️ ${e.message}` });
      } finally { busy.value = false; scroll(); }
    };

    // Micro : appuyer pour parler à Nova
    const talk = () => {
      if (!SR) return toast('La dictée vocale n\'est pas disponible dans ce navigateur (utilisez Chrome, Edge ou Safari)', 'error');
      if (listening.value) { rec?.stop(); return; }
      speechSynthesis?.cancel();
      let said = '';
      rec = createRecognizer({
        continuous: false,
        onText: (t) => { said += ' ' + t; },
        onInterim: (t) => { interim.value = t; },
        onEnd: () => { listening.value = false; interim.value = ''; if (said.trim()) send(said.trim()); },
      });
      listening.value = true;
      rec.start();
    };

    // Écoute continue : chaque phrase dite est enregistrée dans le journal de la journée
    const toggleAmbient = () => {
      if (!SR) return toast('L\'écoute continue nécessite Chrome, Edge ou Safari', 'error');
      if (ambient.value) { ambient.value = false; ambientRec?.stop(); toast('Écoute arrêtée'); return; }
      ambient.value = true;
      const startAmbient = () => {
        ambientRec = createRecognizer({
          continuous: true,
          onText: async (t) => {
            if (t.length < 4) return;
            if (/^(nova|dis nova|ok nova)\b/i.test(t)) return send(t.replace(/^(dis |ok )?nova[ ,]*/i, ''));
            try { await POST('/copilot/journal', { text: t, source: 'voice' }); messages.value.push({ role: 'note', content: t }); scroll(); } catch { /* hors ligne */ }
          },
          onInterim: (t) => { interim.value = t; },
          onEnd: () => { if (ambient.value) setTimeout(() => { try { startAmbient(); } catch { /* déjà relancée */ } }, 300); },
        });
        ambientRec.start();
      };
      startAmbient();
      toast('🎧 Nova écoute : vos phrases sont notées dans le journal. Dites « Nova, … » pour lui demander quelque chose.');
    };
    onUnmounted(() => { ambient.value = false; ambientRec?.stop(); rec?.stop(); });

    const toggleVoice = () => { voiceOn.value = !voiceOn.value; try { localStorage.setItem('nova_voice', voiceOn.value ? '1' : '0'); } catch { /* navigation privée */ } if (!voiceOn.value) speechSynthesis?.cancel(); };
    const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    const hello = computed(() => { const h = new Date().getHours(); return h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir'; });
    const SUGGEST = ['Qu\'est-ce qui est urgent aujourd\'hui ?', 'Fais-moi le résumé de ma journée', 'Rappelle-moi demain à 9h d\'appeler le fournisseur de pneus', 'Combien j\'ai encaissé cette semaine ?'];
    return { open, messages, input, busy, listening, ambient, interim, voiceOn, body, send, talk, toggleAmbient, toggleVoice, onKey, hello, SUGGEST, md, store, voiceSupported };
  },
  template: `
  <button class="copilot-orb no-print" :class="{listening: listening || ambient}" @click="open = !open" title="Nova — copilote IA"><Icon :name="open ? 'x' : 'sparkles'"/></button>
  <div v-if="open" class="copilot-panel no-print">
    <div class="copilot-head">
      <div class="mini-orb"></div>
      <div style="flex:1"><b class="display" style="font-size:16px">Nova</b><div class="small muted">{{ ambient ? '🎧 écoute continue active' : 'Copilote IA — je vous écoute' }}</div></div>
      <button class="icon-btn" :title="voiceOn ? 'Couper la voix' : 'Activer la voix'" @click="toggleVoice"><Icon :name="voiceOn ? 'volume-2' : 'square'"/></button>
      <button class="icon-btn" @click="open = false"><Icon name="x"/></button>
    </div>
    <div class="copilot-body" ref="body">
      <div class="msg assistant"><div class="md">{{ hello }} {{ store.user.name.split(' ')[0] }} ✨ Parlez-moi ou écrivez : je note, je planifie, je réponds à partir de vos vrais chiffres. Chaque soir je vous prépare le résumé de la journée et les priorités du lendemain.</div>
        <div class="suggest"><button v-for="s in SUGGEST" @click="send(s)">{{ s }}</button></div></div>
      <template v-for="m in messages">
        <div v-if="m.role === 'note'" class="journal-note small">📓 {{ m.content }}</div>
        <div v-else class="msg" :class="m.role">
          <div v-if="m.role === 'assistant'" class="md" v-html="md(m.content)"></div><template v-else>{{ m.content }}</template>
          <div v-if="m.actions && m.actions.length"><span v-for="a in m.actions" class="action-chip">{{ a }}</span></div>
        </div>
      </template>
      <div v-if="busy" class="msg assistant"><span class="typing"><span></span><span></span><span></span></span></div>
      <div v-if="interim" class="small muted" style="font-style:italic">« {{ interim }} »</div>
    </div>
    <div class="copilot-foot">
      <button class="mic" :class="{on: listening}" @click="talk" :title="voiceSupported ? 'Appuyez et parlez' : 'Dictée non disponible dans ce navigateur'"><div v-if="listening" class="wave"><i></i><i></i><i></i><i></i><i></i></div><Icon v-else name="mic"/></button>
      <textarea v-model="input" rows="1" placeholder="Demandez ou dictez quelque chose…" @keydown="onKey"></textarea>
      <button class="mic" :class="{on: ambient}" @click="toggleAmbient" title="Écoute continue (journal de la journée)"><Icon name="notebook-pen"/></button>
      <button class="btn primary" style="height:46px" :disabled="busy || !input.trim()" @click="send()"><Icon name="send"/></button>
    </div>
  </div>`,
};

// Carte « Briefing » du tableau de bord
export const BriefCard = {
  setup() {
    const data = ref(null);
    const busy = ref(false);
    const load = async () => { data.value = await GET('/copilot?limit=1'); };
    onMounted(load);
    const brief = computed(() => data.value?.briefs?.[0] || null);
    const generate = async () => { busy.value = true; try { await act(() => POST('/copilot/brief', {}), 'Résumé généré et priorités planifiées'); await load(); } finally { busy.value = false; } };
    const listen = () => speak(`${brief.value.content} Vos priorités : ${brief.value.priorities.map((p, i) => `${i + 1}, ${p.resume}`).join('. ')}`);
    return { data, brief, busy, generate, listen, md, fdate };
  },
  template: `
  <div class="card brief" v-if="data" style="margin-bottom:16px">
    <div class="card-head">
      <div style="display:flex;gap:12px;align-items:center"><div class="mini-orb" style="flex:none;width:34px;height:34px;border-radius:50%;background:conic-gradient(from 0deg,#22d3ee,#818cf8,#e879f9,#22d3ee);box-shadow:0 0 18px rgba(129,140,248,.6)"></div>
        <div><h2 style="margin:0">Briefing de Nova</h2><div class="small muted">{{ brief ? 'Journée du ' + fdate(brief.date) + (brief.ai ? '' : ' · sans IA') : 'Résumé automatique chaque soir à ' + data.config.summary_time }}</div></div></div>
      <div class="btns"><button v-if="brief" class="btn sm" @click="listen"><Icon name="volume-2"/> Écouter</button><button class="btn sm" :disabled="busy" @click="generate"><Icon name="sparkles"/> {{ busy ? 'Nova réfléchit…' : 'Résumer ma journée' }}</button><a class="btn sm" href="#/copilot">Journal</a></div>
    </div>
    <div v-if="brief" class="grid g2">
      <div class="md" v-html="md(brief.content)"></div>
      <div><h3 class="small muted" style="text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Priorités planifiées</h3>
        <div v-for="(p, i) in brief.priorities" class="priority"><span class="n">{{ i + 1 }}</span><div><b>{{ p.resume }}</b><div class="small muted">{{ p.pourquoi }} · {{ fdate(p.echeance) }}</div></div></div>
        <div v-if="!brief.priorities.length" class="muted small">Rien d'urgent 👌</div>
      </div>
    </div>
    <div v-else class="muted">Parlez à Nova (bouton lumineux en bas à droite) pendant la journée : ce soir, elle vous fera le résumé et planifiera les priorités.</div>
  </div>`,
};

// Page « Copilote » : journal, résumés, réglages
export const CopilotPage = {
  components: { BriefCard },
  setup() {
    const data = ref(null);
    const note = ref('');
    const cfg = reactive({});
    const load = async () => { data.value = await GET('/copilot'); Object.assign(cfg, data.value.config); };
    onMounted(load);
    const add = async () => { await act(() => POST('/copilot/journal', { text: note.value })); note.value = ''; load(); };
    const remove = async (j) => { await act(() => DEL('/copilot/journal/' + j.id)); load(); };
    const save = async () => { await act(() => PUT('/copilot/config', cfg), 'Réglages de Nova enregistrés'); };
    return { data, note, cfg, add, remove, save, md, fdate, datetime, store, voiceSupported };
  },
  template: `
  <div v-if="data">
    <div class="page-head"><div><h1><span class="grad-text">Nova</span> — copilote IA</h1><div class="sub">Elle écoute, note, planifie et vous fait le point chaque soir.</div></div></div>
    <BriefCard/>
    <div class="grid g2">
      <div class="card">
        <div class="card-head"><h2 style="margin:0">📓 Journal d'aujourd'hui</h2><span class="muted small">{{ data.journal.length }} note(s)</span></div>
        <div class="btns" style="margin-bottom:12px"><input v-model="note" style="flex:1" placeholder="Ex. : Le client de la Golf rappelle demain pour le devis freins" @keydown.enter="note.trim() && add()"><button class="btn primary" :disabled="!note.trim()" @click="add">Noter</button></div>
        <div v-for="j in data.journal" class="journal-note"><div class="small muted">{{ j.created_at.slice(11, 16) }} · {{ j.source === 'voice' ? '🎙️ dicté' : j.source === 'ia' ? '✨ noté par Nova' : '⌨️ écrit' }} <button class="link small" style="float:right" @click="remove(j)">supprimer</button></div>{{ j.text }}</div>
        <Empty v-if="!data.journal.length" icon="🎧" text="Activez l'écoute continue (icône carnet dans Nova) ou dictez vos notes : tout est rassemblé ici pour le résumé du soir."/>
      </div>
      <div class="card">
        <h2>⚙️ Réglages</h2>
        <div class="form-grid">
          <label>Heure du résumé automatique<input type="time" v-model="cfg.summary_time"></label>
          <label class="check"><input type="checkbox" v-model="cfg.enabled"> Résumé automatique chaque jour</label>
          <label class="check"><input type="checkbox" v-model="cfg.auto_plan"> Planifier automatiquement les priorités (activités)</label>
          <label class="check"><input type="checkbox" v-model="cfg.email_me"> M'envoyer le résumé par e-mail</label>
        </div>
        <button class="btn primary" style="margin-top:12px" @click="save">Enregistrer</button>
        <p class="muted small" style="margin-top:14px">🎙️ Voix : {{ voiceSupported ? 'disponible dans ce navigateur' : 'non disponible ici — utilisez Chrome, Edge ou Safari' }}. {{ data.ai ? '' : 'Sans clé API Claude, Nova note votre journal et fait un résumé chiffré simple.' }}</p>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <h2>🗂️ Résumés précédents</h2>
      <details v-for="b in data.briefs" class="result"><summary><b>{{ fdate(b.date) }}</b><span class="muted small">{{ b.priorities.length }} priorité(s)</span></summary>
        <div class="md" v-html="md(b.content)"></div>
        <div style="padding:0 13px 13px"><div v-for="(p, i) in b.priorities" class="priority"><span class="n">{{ i + 1 }}</span><div><b>{{ p.resume }}</b><div class="small muted">{{ p.pourquoi }} · {{ fdate(p.echeance) }}</div></div></div></div>
      </details>
      <Empty v-if="!data.briefs.length" icon="🧠" text="Aucun résumé pour l'instant"/>
    </div>
  </div>`,
};
