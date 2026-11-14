// Fenêtre « Écouter le client » (devis et ordres de réparation) : l'écoute démarre à l'ouverture, le client explique sa
// demande, le service de dictée du navigateur la transcrit, puis l'IA en fait un résumé court pour le mécanicien.
// Le logiciel n'enregistre et ne reçoit aucun son : il ne voit que le texte.
// Sans micro (navigateur, adresse non sécurisée) ou sans clé IA, la fenêtre reste utile : on écrit, on corrige,
// et le texte peut être mis tel quel dans le document.
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { GET, POST, toast, store } from './api.js';
import { voiceSupported, createRecognizer, micHold } from './copilot.js';
import { leaveGuards } from './router.js';

const MAX_CHARS = 12000; // même limite que le serveur (environ un quart d'heure de parole)
const LANGS = [['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['pt-PT', 'Português'], ['en-GB', 'English']];
// erreurs après lesquelles il ne sert à rien de relancer l'écoute
const FATAL = {
  'not-allowed': 'Le navigateur n’a pas accès au micro. Autorisez le micro pour cette page (icône à gauche de l’adresse), puis réessayez.',
  'service-not-allowed': 'La dictée est désactivée sur cet appareil (réglages du navigateur ou du téléphone).',
  'audio-capture': 'Aucun micro n’a été trouvé sur cet appareil.',
  network: 'La dictée du navigateur a besoin d’internet : vérifiez la connexion, puis réessayez.',
  'language-not-supported': 'Cette langue n’est pas prise en charge par la dictée de ce navigateur.',
};

export const VoiceRequest = {
  // hostDirty : le document a déjà des modifications non enregistrées (sa propre question couvre alors la sortie de page)
  props: { type: String, vehicleId: [Number, String], mileage: [Number, String], current: String, hostDirty: Boolean },
  emits: ['close', 'apply'],
  setup(props, { emit }) {
    const text = ref(''); // ce qui a été dicté ou écrit (toujours modifiable)
    const interim = ref(''); // phrase en cours, pas encore fixée
    const listening = ref(false);
    const seconds = ref(0);
    const problem = ref(''); // pourquoi l'écoute s'est arrêtée
    const busy = ref(false); // une action est en cours (attente de la dernière phrase, résumé)
    const summarizing = ref(false); // l'IA rédige
    const summary = ref(null); // null tant qu'aucun résumé n'a été demandé
    const questions = ref([]);
    const box = ref(null);
    let saved = null;
    try { saved = localStorage.getItem('garage_voice_lang'); } catch { /* stockage indisponible */ }
    const lang = ref(LANGS.some(([c]) => c === saved) ? saved : 'fr-FR');
    const hasCurrent = computed(() => !!String(props.current || '').trim());
    const mode = ref('append'); // une demande est déjà écrite : par défaut on ajoute à la suite, rien n'est perdu
    const docName = computed(() => (props.type === 'quote' ? 'le devis' : 'l’OR'));

    // Le micro n'est accordé par les navigateurs que sur une adresse sécurisée (https) ou sur l'ordinateur lui-même
    const micOk = voiceSupported && window.isSecureContext !== false;
    const micNote = !voiceSupported
      ? 'La dictée n’est pas disponible dans ce navigateur (elle fonctionne avec Chrome, Edge et Safari). Écrivez la demande ci-dessous — sur téléphone, la touche micro du clavier dicte aussi.'
      : !micOk
        ? 'Le micro n’est autorisé que sur une adresse sécurisée (https) ou sur l’ordinateur où le logiciel est installé. Écrivez la demande ci-dessous — sur téléphone, la touche micro du clavier dicte aussi.'
        : '';

    // `active` : une session de dictée du navigateur est ouverte (après l'arrêt, elle livre encore la dernière phrase)
    let rec = null, timer = null, restart = null, last = '', startedAt = 0, quick = 0, waiters = [], active = false;
    const scrollDown = () => { if (box.value) box.value.scrollTop = box.value.scrollHeight; };
    // Une phrase arrive pendant que l'accueil corrige un mot : le curseur reste où il est (sinon il sauterait à la fin à chaque phrase)
    // `keep` : longueur du début du texte qui n'a pas bougé (le curseur n'est jamais replacé au-delà).
    const setText = (v, keep) => {
      const el = box.value;
      const sel = el && document.activeElement === el ? [Math.min(el.selectionStart, keep), Math.min(el.selectionEnd, keep)] : null;
      // l'affichage suit la dictée tant qu'on était déjà en bas du texte (même avec le curseur dans la zone)
      const stick = !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      text.value = v;
      nextTick(() => { if (sel && box.value) box.value.setSelectionRange(sel[0], sel[1]); if (!sel || stick) scrollDown(); });
    };
    const append = (t) => {
      if (!t) return;
      const cur = text.value.trimEnd();
      // certains téléphones renvoient deux fois la même phrase, ou la même phrase qui s'allonge : on ne la garde qu'une fois
      if (last && cur.endsWith(last)) {
        if (t === last) return;
        if (t.startsWith(last)) { setText(cur.slice(0, cur.length - last.length) + t, cur.length); last = t; return; }
      }
      setText(cur ? cur + ' ' + t : t, cur.length);
      last = t;
      if (text.value.length > MAX_CHARS - 600) { problem.value = 'Le texte est très long : l’écoute est arrêtée. Résumez cette partie, puis recommencez pour la suite.'; stop(); }
    };
    const ended = () => { const w = waiters; waiters = []; w.forEach((f) => f()); };
    const listen = () => {
      startedAt = Date.now();
      const before = text.value.length;
      const mine = createRecognizer({
        continuous: true,
        onText: append,
        onInterim: (t) => { if (rec === mine) interim.value = t; },
        onError: (err) => { if (rec === mine && FATAL[err]) { problem.value = FATAL[err]; stop(); } },
        onEnd: () => {
          if (rec !== mine) return; // une écoute plus récente a pris le relais (arrêt puis reprise rapprochés)
          active = false;
          ended();
          interim.value = '';
          if (!listening.value) return;
          // Le navigateur coupe l'écoute après un silence : on la relance. S'il la coupe aussitôt, plusieurs fois de suite, on arrête.
          quick = Date.now() - startedAt < 1200 && text.value.length === before ? quick + 1 : 0;
          if (quick >= 5) { problem.value = 'La dictée s’arrête toute seule sur cet appareil. Réessayez, ou écrivez la demande ci-dessous.'; stop(); return; }
          restart = setTimeout(() => { if (listening.value && rec === mine) { try { listen(); } catch { stop(); } } }, 250);
        },
      });
      rec = mine;
      mine.lang = lang.value;
      mine.start();
      active = true;
    };
    const start = () => {
      if (listening.value || !micOk) return;
      problem.value = '';
      quick = 0;
      listening.value = true;
      seconds.value = 0;
      timer = setInterval(() => { seconds.value++; }, 1000);
      try { listen(); } catch { problem.value = 'La dictée n’a pas pu démarrer. Réessayez, ou écrivez la demande ci-dessous.'; stop(); }
    };
    function stop() {
      listening.value = false;
      clearInterval(timer);
      clearTimeout(restart);
      try { rec?.stop(); } catch { /* déjà arrêtée */ }
    }
    // Arrêter, puis attendre la dernière phrase : le navigateur la livre juste après l'arrêt, même si le micro a déjà été
    // coupé à la main. Sans session ouverte (pause entre deux écoutes, micro jamais démarré), il n'y a rien à attendre.
    const stopAndWait = () => new Promise((resolve) => {
      stop();
      if (!active) return resolve();
      waiters.push(resolve);
      setTimeout(resolve, 1500);
    });
    // Changer de langue pendant l'écoute : la dictée s'arrête et repart aussitôt dans la nouvelle langue (voir onEnd)
    watch(lang, (l) => {
      try { localStorage.setItem('garage_voice_lang', l); } catch { /* stockage indisponible */ }
      if (listening.value) { try { rec?.stop(); } catch { /* déjà arrêtée */ } }
    });
    // Quitter la page (bouton Retour, rechargement) avec du texte dicté : même question qu'à la fermeture de la fenêtre
    const unsaved = () => !!(text.value.trim() || interim.value.trim());
    const leaveOk = () => !unsaved() || props.hostDirty || confirm('Quitter sans rien mettre dans le document ? Le texte dicté sera perdu.');
    const onUnload = (e) => { if (unsaved()) { e.preventDefault(); e.returnValue = ''; } };
    onMounted(() => {
      leaveGuards.add(leaveOk);
      window.addEventListener('beforeunload', onUnload);
      micHold.value = true; // l'écoute continue de Nova laisse le micro à cette fenêtre
      // la clé Claude a pu être enregistrée depuis un autre poste pendant que cet écran restait ouvert
      GET('/auth/status').then((r) => { store.ai = !!r.ai; }).catch(() => { /* hors ligne : on garde l'état connu */ });
      // Le bouton s'appelle « Écouter le client » : l'écoute commence dès l'ouverture de la fenêtre
      if (micOk) start();
    });
    onUnmounted(() => {
      leaveGuards.delete(leaveOk);
      window.removeEventListener('beforeunload', onUnload);
      stop();
      try { rec?.abort(); } catch { /* rien à arrêter */ }
      micHold.value = false;
    });

    const clock = computed(() => Math.floor(seconds.value / 60) + ':' + String(seconds.value % 60).padStart(2, '0'));
    const state = computed(() => (listening.value ? 'J’écoute…'
      : !micOk ? 'Écrivez ce que demande le client'
        : text.value.trim() ? 'Écoute arrêtée — vous pouvez corriger le texte' : 'Appuyez sur le micro, puis laissez parler le client'));

    // `busy` est pris avant toute attente : un second clic ne lance ni un second résumé, ni une insertion sans la dernière phrase
    const summarize = async () => {
      if (busy.value) return;
      busy.value = true;
      try {
        await stopAndWait();
        const t = text.value.trim();
        if (!t) { toast('Dictez ou écrivez d’abord ce que demande le client', 'error'); return; }
        summarizing.value = true;
        const r = await POST('/documents/request-summary', { type: props.type, transcript: t, vehicle_id: props.vehicleId || null, mileage: props.mileage || null, lang: lang.value.slice(0, 2) });
        summary.value = r.summary;
        questions.value = r.questions || [];
      } catch (e) { toast(e.message, 'error'); } finally { busy.value = false; summarizing.value = false; }
    };
    const apply = async (raw) => {
      if (busy.value) return;
      if (raw) { busy.value = true; try { await stopAndWait(); } finally { busy.value = false; } }
      const value = String(raw ? text.value : summary.value || '').trim();
      if (!value) { toast(raw ? 'Dictez ou écrivez d’abord ce que demande le client' : 'Le résumé est vide', 'error'); return; }
      emit('apply', { text: value, mode: hasCurrent.value ? mode.value : 'replace' });
    };
    const close = () => {
      if (unsaved() && !confirm('Fermer sans rien mettre dans le document ? Le texte dicté sera perdu.')) return;
      stop();
      emit('close');
    };
    return { text, interim, listening, problem, busy, summarizing, summary, questions, box, lang, LANGS, hasCurrent, mode, docName, micOk, micNote, state, clock, store, start, stop, summarize, apply, close };
  },
  template: `
  <Modal title="Écouter le client" wide @close="close">
    <template v-if="summary === null">
      <div class="vr-top">
        <button type="button" class="vr-mic" :class="{ on: listening }" :disabled="!micOk || busy" @click="listening ? stop() : start()" :title="listening ? 'Arrêter l’écoute' : 'Démarrer l’écoute'" :aria-label="listening ? 'Arrêter l’écoute' : 'Démarrer l’écoute'"><Icon :name="listening ? 'square' : 'mic'"/></button>
        <div class="vr-state"><b><span aria-live="polite">{{ state }}</span><span v-if="listening" class="vr-clock"> {{ clock }}</span></b><div class="muted small">La transcription est faite par le service de dictée de votre navigateur. Le logiciel n’enregistre pas le son : il ne garde que le texte ci-dessous, que vous pouvez corriger.</div></div>
        <label class="vr-lang">Langue parlée<select v-model="lang"><option v-for="l in LANGS" :value="l[0]">{{ l[1] }}</option></select></label>
      </div>
      <p v-if="micNote" class="vr-note"><Icon name="info" class="ti"/> <span>{{ micNote }}</span></p>
      <p v-if="problem" class="vr-note bad" role="alert"><Icon name="info" class="ti"/> <span>{{ problem }}</span></p>
      <label>Ce que dit le client
        <textarea ref="box" v-model="text" rows="7" maxlength="12000" placeholder="Le texte apparaît ici pendant que le client parle. Vous pouvez aussi l’écrire ou le corriger."></textarea>
      </label>
      <div class="vr-interim" :class="{ on: listening }">{{ interim || (listening ? '…' : '') }}</div>
      <p v-if="!store.ai" class="vr-note"><Icon name="info" class="ti"/> <span>Le résumé par l’IA n’est pas activé sur ce logiciel (aucune clé Claude). Vous pouvez mettre le texte tel quel dans {{ docName }}.</span></p>
    </template>
    <template v-else>
      <label>Demande du client, pour le mécanicien
        <textarea v-model="summary" rows="7"></textarea>
      </label>
      <div class="muted small">Relisez le résumé avant de le mettre dans {{ docName }} : vous pouvez le corriger ici.</div>
      <div v-if="questions.length" class="vr-ask">
        <b><Icon name="circle-help" class="ti"/> À préciser avec le client, tant qu’il est là</b>
        <ul><li v-for="q in questions">{{ q }}</li></ul>
      </div>
      <details class="vr-said"><summary>Voir ce qui a été dicté</summary><p>{{ text }}</p></details>
    </template>
    <div v-if="hasCurrent" class="vr-mode">
      <span class="muted small">Une demande est déjà écrite dans {{ docName }} :</span>
      <div class="seg"><button type="button" :class="{ on: mode === 'append' }" @click="mode = 'append'">Ajouter à la suite</button><button type="button" :class="{ on: mode === 'replace' }" @click="mode = 'replace'">La remplacer</button></div>
    </div>
    <template #foot>
      <template v-if="summary === null">
        <button class="btn" :disabled="busy || !text.trim()" @click="apply(true)">Mettre le texte tel quel</button>
        <button class="btn primary" :disabled="busy || !text.trim() || !store.ai" @click="summarize"><Icon name="sparkles" class="ti"/> {{ summarizing ? 'L’IA rédige le résumé…' : 'Résumer pour le mécanicien' }}</button>
      </template>
      <template v-else>
        <button class="btn" :disabled="busy" @click="summary = null"><Icon name="undo-2" class="ti"/> Revenir au texte dicté</button>
        <button class="btn primary" :disabled="busy || !summary.trim()" @click="apply(false)"><Icon name="check" class="ti"/> Mettre dans {{ docName }}</button>
      </template>
    </template>
  </Modal>`,
};
