import { ref, onMounted, onUnmounted } from 'vue';
import { GET, PUT, DEL, act, hours, time, date, today, addDays } from '../api.js';

export const Timesheets = {
  setup() {
    const from = ref(today());
    const to = ref(today());
    const data = ref(null);
    const edit = ref(null);
    const load = async () => { data.value = await GET(`/timesheets?from=${from.value}&to=${to.value}`); };
    let t;
    onMounted(() => { load(); t = setInterval(load, 30000); });
    onUnmounted(() => clearInterval(t));
    const day = () => { from.value = to.value = today(); load(); };
    const week = () => { const d = new Date(); from.value = addDays(today(), -((d.getDay() + 6) % 7)); to.value = today(); load(); };
    const save = async () => { await act(() => PUT('/timesheets/' + edit.value.id, { start: edit.value.start, end: edit.value.end || null, note: edit.value.note }), 'Pointage corrigé'); edit.value = null; load(); };
    const remove = async () => { await act(() => DEL('/timesheets/' + edit.value.id)); edit.value = null; load(); };
    return { from, to, data, load, day, week, edit, save, remove, hours, time, date, today };
  },
  template: `
  <div>
    <div class="page-head">
      <div><h1>Pointage</h1><div class="sub">Présence et temps passé sur les ordres de réparation. Les mécaniciens pointent sur <a href="/kiosk.html" target="_blank">le kiosque atelier</a>.</div></div>
      <div class="toolbar" style="margin:0"><input type="date" v-model="from" @change="load"> → <input type="date" v-model="to" @change="load"><button class="btn sm" @click="day">Aujourd'hui</button><button class="btn sm" @click="week">Semaine</button></div>
    </div>
    <template v-if="data">
      <div class="grid g4" style="margin-bottom:16px">
        <div v-for="u in data.users" class="kpi">
          <div class="l"><span class="avatar" :style="{background: u.color, width: '22px', height: '22px', fontSize: '10px'}">{{ u.name[0] }}</span>{{ u.name }} <span v-if="u.active" class="live">actif</span></div>
          <div class="v">{{ hours(u.work) }}</div>
          <div class="muted small">sur OR · présence {{ hours(u.presence) }} <b v-if="u.productivity !== null" :class="u.productivity >= 80 ? 'pos' : 'neg'">· {{ u.productivity }} % productif</b></div>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap"><table>
          <thead><tr><th>Mécanicien</th><th>Type</th><th>Date</th><th>Début</th><th>Fin</th><th class="num">Durée</th><th>OR</th><th>Note</th></tr></thead>
          <tbody><tr v-for="e in data.entries" class="click" @click="edit = {...e, start: e.start.slice(0,16), end: e.end ? e.end.slice(0,16) : ''}">
            <td>{{ e.user_name }}</td><td><span class="badge" :class="e.kind === 'work' ? 'b-blue' : 'b-gray'">{{ e.kind === 'work' ? 'Travail' : 'Présence' }}</span></td>
            <td>{{ date(e.start.slice(0,10)) }}</td><td>{{ time(e.start) }}</td><td><span v-if="e.end">{{ time(e.end) }}</span><span v-else class="live">en cours</span></td>
            <td class="num">{{ hours(e.hours) }}</td><td><a v-if="e.document_id" :href="'#/document/' + e.document_id" @click.stop>{{ e.document_number }} <span class="plate" v-if="e.plate">{{ e.plate }}</span></a></td><td class="small">{{ e.note }}</td>
          </tr></tbody>
        </table></div>
        <Empty v-if="!data.entries.length" icon="⏱️" text="Aucun pointage sur la période"/>
      </div>
    </template>
    <Modal v-if="edit" title="Corriger le pointage" @close="edit = null">
      <div class="form-grid"><label>Début<input type="datetime-local" v-model="edit.start"></label><label>Fin<input type="datetime-local" v-model="edit.end"></label></div>
      <label>Note<input v-model="edit.note"></label>
      <template #foot><button class="btn danger" style="margin-right:auto" @click="remove">Supprimer</button><button class="btn primary" @click="save">Enregistrer</button></template>
    </Modal>
  </div>`,
};
