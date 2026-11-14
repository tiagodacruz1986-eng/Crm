import { ref, onMounted, onUnmounted } from 'vue';
import { GET, PUT, DEL, act, hours, time, date, today, addDays } from '../api.js';
import { can } from '../apps.js';
import { gapLabel } from '../worktime.js';

export const Timesheets = {
  setup() {
    const from = ref(today());
    const to = ref(today());
    const data = ref(null);
    const edit = ref(null);
    const stats = ref(null);
    const load = async () => {
      const q = `from=${from.value}&to=${to.value}`;
      // pointages + temps prévu / temps passé par intervention et par mécanicien sur la même période
      const [d, s] = await Promise.all([GET('/timesheets?' + q), GET('/timesheets/stats?' + q)]);
      data.value = d; stats.value = s;
    };
    const statOf = (u) => (stats.value?.mechanics || []).find((m) => m.id === u.id) || null;
    const month = () => { from.value = today().slice(0, 8) + '01'; to.value = today(); load(); };
    let t;
    onMounted(() => { load(); t = setInterval(load, 30000); });
    onUnmounted(() => clearInterval(t));
    const day = () => { from.value = to.value = today(); load(); };
    const week = () => { const d = new Date(); from.value = addDays(today(), -((d.getDay() + 6) % 7)); to.value = today(); load(); };
    const save = async () => { await act(() => PUT('/timesheets/' + edit.value.id, { start: edit.value.start, end: edit.value.end || null, note: edit.value.note }), 'Pointage corrigé'); edit.value = null; load(); };
    const remove = async () => { if (!confirm('Supprimer ce pointage ?')) return; await act(() => DEL('/timesheets/' + edit.value.id), 'Pointage supprimé'); edit.value = null; load(); };
    const canFix = can('presences', 'manager'); // corriger un pointage : administrateurs des présences
    return { stats, statOf, month, gapLabel, canFix, from, to, data, load, day, week, edit, save, remove, hours, time, date, today };
  },
  template: `
  <div>
    <div class="page-head">
      <div><h1>Pointage</h1><div class="sub">Présence et temps passé sur chaque intervention des ordres de réparation. Les mécaniciens pointent sur <a href="/kiosk.html" target="_blank">le kiosque atelier</a>.</div></div>
      <div class="toolbar" style="margin:0"><ModuleTools module="pointage"/><input type="date" v-model="from" @change="load"> → <input type="date" v-model="to" @change="load"><button class="btn sm" @click="day">Aujourd'hui</button><button class="btn sm" @click="week">Semaine</button><button class="btn sm" @click="month">Mois</button></div>
    </div>
    <template v-if="data">
      <div class="grid g4" style="margin-bottom:16px">
        <div v-for="u in data.users" class="kpi">
          <div class="l"><span class="avatar" :style="{background: u.color, width: '22px', height: '22px', fontSize: '10px'}">{{ u.name[0] }}</span>{{ u.name }} <span v-if="u.active" class="live">actif</span></div>
          <div class="v">{{ hours(u.work) }}</div>
          <div class="muted small">sur OR · présence {{ hours(u.presence) }} <b v-if="u.productivity !== null" :class="u.productivity >= 80 ? 'pos' : 'neg'">· {{ u.productivity }} % productif</b></div>
          <div v-if="statOf(u) && statOf(u).interventions" class="small" style="margin-top:4px">
            {{ statOf(u).interventions }} intervention(s) : prévu {{ hours(statOf(u).planned) }}, passé {{ hours(statOf(u).spent) }}
            <b :class="statOf(u).gap > 0.005 ? 'neg' : 'pos'">({{ gapLabel(statOf(u).gap) }})</b>
            <b v-if="statOf(u).overruns" class="wt-over"> · {{ statOf(u).overruns }} dépassement(s)</b>
            <span v-if="statOf(u).to_check" class="warn"> · {{ statOf(u).to_check }} à vérifier</span>
          </div>
        </div>
      </div>
      <div class="card" v-if="stats && stats.interventions.length" style="margin-bottom:16px">
        <div class="card-head"><h2>Interventions : temps prévu et temps passé</h2><span class="small muted">en rouge : temps prévu dépassé</span></div>
        <div class="table-wrap"><table class="wt-table">
          <thead><tr><th>Intervention</th><th>OR</th><th>Mécanicien(s)</th><th class="num">Prévu</th><th class="num">Passé</th><th class="num">Écart</th><th>État</th></tr></thead>
          <tbody><tr v-for="x in stats.interventions" :key="x.document_id + '-' + (x.line_id || 0)">
            <td>{{ x.description }}</td>
            <td><a :href="'#/document/' + x.document_id">{{ x.number }}</a> <span class="plate" v-if="x.plate">{{ x.plate }}</span></td>
            <td>{{ x.mechanics }}</td>
            <td class="num">{{ x.planned !== null ? hours(x.planned) : '—' }}</td>
            <td class="num"><b :class="{ 'wt-over': x.over > 0 }">{{ hours(x.spent) }}</b><div v-if="Math.abs(x.spent - x.period_spent) > 0.01" class="small muted">dont {{ hours(x.period_spent) }} sur la période</div></td>
            <td class="num"><b v-if="x.planned !== null" :class="x.over > 0 ? 'wt-over' : 'pos'">{{ gapLabel(x.spent - x.planned) }}</b><span v-else class="muted">—</span></td>
            <td><span v-if="x.active" class="live" :class="{ over: x.over > 0 }">en cours</span><span v-else-if="x.finished" class="badge b-green">Terminé</span><span v-else class="badge b-gray">En pause</span>
              <div v-if="x.auto" class="small warn" title="Un chrono oublié a été arrêté automatiquement : corrigez ses heures dans la liste ci-dessous">⚠ durée à vérifier</div></td>
          </tr></tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="table-wrap"><table>
          <thead><tr><th>Mécanicien</th><th>Type</th><th>Date</th><th>Début</th><th>Fin</th><th class="num">Durée</th><th>OR</th><th>Intervention</th><th>Note</th></tr></thead>
          <tbody><tr v-for="e in data.entries" :class="{click: canFix}" @click="canFix && (edit = {...e, start: e.start.slice(0,16), end: e.end ? e.end.slice(0,16) : ''})">
            <td>{{ e.user_name }}</td><td><span class="badge" :class="e.kind === 'work' ? 'b-blue' : 'b-gray'">{{ e.kind === 'work' ? 'Travail' : 'Présence' }}</span></td>
            <td>{{ date(e.start.slice(0,10)) }}</td><td>{{ time(e.start) }}</td><td><span v-if="e.end">{{ time(e.end) }}</span><span v-else class="live">en cours</span></td>
            <td class="num">{{ hours(e.hours) }}</td><td><a v-if="e.document_id" :href="'#/document/' + e.document_id" @click.stop>{{ e.document_number }} <span class="plate" v-if="e.plate">{{ e.plate }}</span></a></td><td class="small">{{ e.line_description }}</td><td class="small">{{ e.note }}</td>
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
