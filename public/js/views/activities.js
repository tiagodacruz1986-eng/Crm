import { ref, computed, onMounted, watch } from 'vue';
import { GET, DEL, act, datetime, today } from '../api.js';
import { ActivityModal, ActivityItem, MailComposer, loadMeta, meta, bus } from '../mail.js';

export const Activities = {
  components: { ActivityModal, ActivityItem },
  setup() {
    const list = ref([]);
    const mine = ref(true);
    const module = ref('');
    const creating = ref(false);
    const editing = ref(null);
    const load = async () => { list.value = await GET(`/activities?${mine.value ? 'mine=1&' : ''}${module.value ? 'module=' + module.value : ''}`); };
    onMounted(async () => { await loadMeta(); load(); });
    watch(() => bus.tick, load);
    const cols = computed(() => [
      ['⚠️ En retard', list.value.filter((a) => a.due_date < today()), 'late'],
      ["📍 Aujourd'hui", list.value.filter((a) => a.due_date === today()), 'today'],
      ['🗓️ À venir', list.value.filter((a) => a.due_date > today()), ''],
    ]);
    return { list, mine, module, creating, editing, load, cols, meta };
  },
  template: `
  <div>
    <div class="page-head">
      <div><h1>Activités</h1><div class="sub">Toutes les tâches planifiées : appels, relances, commandes, rappels… sur chaque module et chaque fiche.</div></div>
      <div class="btns">
        <select v-model="mine" @change="load" style="width:auto"><option :value="true">Mes activités</option><option :value="false">Toute l'équipe</option></select>
        <select v-model="module" @change="load" style="width:auto"><option value="">Tous les modules</option><option v-for="(l, k) in meta.modules" :value="k">{{ l }}</option></select>
        <button class="btn primary" @click="creating = true">+ Nouvelle activité</button>
      </div>
    </div>
    <div class="grid g3">
      <div v-for="[title, items, cls] in cols" class="kcol">
        <div class="kcol-head"><span>{{ title }}</span><span class="badge" :class="cls === 'late' && items.length ? 'b-red' : 'b-gray'">{{ items.length }}</span></div>
        <ActivityItem v-for="a in items" :key="a.id" :a="a" show-record @changed="load" @edit="editing = $event"/>
        <div v-if="!items.length" class="muted small pad">Rien ici 👍</div>
      </div>
    </div>
    <ActivityModal v-if="creating || editing" :activity="editing" @close="creating = false; editing = null" @saved="load"/>
  </div>`,
};

const STATUS = { sent: ['Envoyé', 'b-green'], scheduled: ['Programmé', 'b-blue'], error: ['Échec', 'b-red'], cancelled: ['Annulé', 'b-gray'], sending: ['Envoi…', 'b-orange'] };

export const MailOutbox = {
  components: { MailComposer },
  setup() {
    const rows = ref([]);
    const composing = ref(false);
    const load = async () => { rows.value = await GET('/mail/outbox'); };
    onMounted(load);
    watch(() => bus.tick, load);
    const cancel = async (e) => { await act(() => DEL('/mail/' + e.id), 'Envoi annulé'); load(); };
    return { rows, composing, load, cancel, datetime, STATUS };
  },
  template: `
  <div>
    <div class="page-head"><div><h1>E-mails</h1><div class="sub">Tous les e-mails envoyés et programmés depuis le logiciel.</div></div><button class="btn primary" @click="composing = true">✉️ Nouvel e-mail</button></div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Destinataire</th><th>Objet</th><th>Fiche</th><th>Statut</th><th></th></tr></thead>
        <tbody><tr v-for="e in rows">
          <td class="nowrap">{{ e.status === 'scheduled' ? '🕒 ' + datetime(e.scheduled_at) : datetime(e.sent_at || e.created_at.replace(' ', 'T') + 'Z') }}</td>
          <td>{{ e.to_addr }}</td><td>{{ e.subject }}<div v-if="e.error" class="neg small">{{ e.error }}</div></td>
          <td><a v-if="e.record" :href="'#' + e.record.link">{{ e.record.label }}</a></td>
          <td><span class="badge" :class="STATUS[e.status]?.[1]">{{ STATUS[e.status]?.[0] || e.status }}</span></td>
          <td><button v-if="e.status === 'scheduled'" class="btn sm danger" @click="cancel(e)">Annuler</button></td>
        </tr></tbody>
      </table></div>
      <Empty v-if="!rows.length" icon="✉️" text="Aucun e-mail pour l'instant"/>
    </div>
    <MailComposer v-if="composing" @close="composing = false"/>
  </div>`,
};
