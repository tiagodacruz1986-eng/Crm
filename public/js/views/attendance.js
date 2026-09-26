// Présences (comme Odoo) : gros bouton Arrivée / Départ, équipe en direct, rapports et corrections.
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { GET, POST, PUT, DEL, act, toast, store, hours, time, date, today, addDays } from '../api.js';
import { route, go } from '../router.js';
import { can } from '../apps.js';

const monday = (d = today()) => { const x = new Date(d + 'T12:00:00'); return addDays(d, -((x.getDay() + 6) % 7)); };
const elapsedSince = (s, now) => { if (!s) return '00:00:00'; const sec = Math.max(0, Math.floor((now - new Date(s)) / 1000)); return [sec / 3600, (sec % 3600) / 60, sec % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'); };

export const Attendance = {
  setup() {
    const tab = ref(route.query.tab || 'me');
    watch(() => route.query.tab, (t) => { tab.value = t || 'me'; load(); });
    const me = ref(null);
    const team = ref([]);
    const report = ref([]);
    const entries = ref([]);
    const period = reactive({ from: monday(), to: today(), user_id: '' });
    const edit = ref(null);
    const busy = ref(false);
    const flash = ref(null);
    const now = ref(Date.now());
    const manager = computed(() => can('presences', 'manager'));
    const viewer = computed(() => can('presences', 'read'));
    let t1, t2;

    const load = async () => {
      if (tab.value === 'me') me.value = await GET('/attendance/me');
      if (tab.value === 'board' && viewer.value) team.value = await GET('/attendance/board');
      if (tab.value === 'report' && viewer.value) {
        const qs = `from=${period.from}&to=${period.to}${period.user_id ? '&user_id=' + period.user_id : ''}`;
        [report.value, entries.value] = await Promise.all([GET(`/attendance/report?from=${period.from}&to=${period.to}`), GET('/attendance?' + qs)]);
      }
    };
    onMounted(() => { load(); t1 = setInterval(() => { now.value = Date.now(); }, 1000); t2 = setInterval(load, 30_000); });
    onUnmounted(() => { clearInterval(t1); clearInterval(t2); clearTimeout(flashT); });
    const setTab = (t) => go('/attendance' + (t === 'me' ? '' : '?tab=' + t));

    let flashT;
    const check = async () => {
      busy.value = true;
      try {
        const r = await POST('/attendance/check', {});
        me.value = r;
        if (store.user) store.user.attendance = r;
        flash.value = r.action;
        clearTimeout(flashT);
        flashT = setTimeout(() => { flash.value = null; }, 3500);
      } catch (e) { toast(e.message, 'error'); } finally { busy.value = false; }
    };
    const todayLive = computed(() => {
      if (!me.value) return 0;
      return me.value.today_hours;
    });
    const progress = computed(() => (me.value?.expected_today ? Math.min(100, Math.round((me.value.today_hours / me.value.expected_today) * 100)) : 0));

    const setPeriod = (k) => {
      const t = today();
      if (k === 'today') Object.assign(period, { from: t, to: t });
      if (k === 'week') Object.assign(period, { from: monday(), to: t });
      if (k === 'lastweek') Object.assign(period, { from: addDays(monday(), -7), to: addDays(monday(), -1) });
      if (k === 'month') Object.assign(period, { from: t.slice(0, 8) + '01', to: t });
      load();
    };
    const totals = computed(() => report.value.reduce((s, r) => ({ worked: s.worked + r.worked, expected: s.expected + r.expected, overtime: s.overtime + r.overtime }), { worked: 0, expected: 0, overtime: 0 }));
    const newEntry = () => { edit.value = { user_id: period.user_id || '', start: today() + 'T08:00', end: today() + 'T17:00', note: '' }; };
    const saveEntry = async () => {
      const e = edit.value;
      const body = { user_id: e.user_id, start: e.start.slice(0, 16), end: e.end ? e.end.slice(0, 16) : null, note: e.note };
      if (e.id) await act(() => PUT('/attendance/' + e.id, body), 'Pointage corrigé'); else await act(() => POST('/attendance', body), 'Pointage ajouté');
      edit.value = null; load();
    };
    const removeEntry = async () => { if (!confirm('Supprimer ce pointage ?')) return; await act(() => DEL('/attendance/' + edit.value.id), 'Pointage supprimé'); edit.value = null; load(); };
    const exportCsv = () => {
      const rows = [['Employé', 'Date', 'Arrivée', 'Départ', 'Heures', 'Note'], ...entries.value.map((e) => [e.user_name, e.start.slice(0, 10), e.start.slice(11, 16), e.end ? e.end.slice(11, 16) : '', String(e.hours).replace('.', ','), e.note || ''])];
      const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
      a.download = `presences_${period.from}_${period.to}.csv`;
      a.click();
    };
    const users = computed(() => report.value.map((r) => ({ id: r.user_id, name: r.name })));
    return { tab, setTab, me, team, report, entries, period, edit, busy, flash, now, manager, viewer, check, todayLive, progress, setPeriod, totals, newEntry, saveEntry, removeEntry, exportCsv, users, load,
      hours, time, date, store, elapsedSince };
  },
  template: `
  <div>
    <div class="page-head"><div><h1>Présences</h1><div class="sub">Arrivées, départs et heures de l'équipe</div></div>
      <div class="btns"><a class="btn" href="/kiosk.html" target="_blank"><Icon name="tablet"/> Mode kiosque</a></div></div>
    <div class="tabs att-tabs">
      <button :class="{active: tab === 'me'}" @click="setTab('me')">Mon pointage</button>
      <button v-if="viewer" :class="{active: tab === 'board'}" @click="setTab('board')">Équipe</button>
      <button v-if="viewer" :class="{active: tab === 'report'}" @click="setTab('report')">Rapports</button>
    </div>

    <div v-if="tab === 'me' && me" class="att-me card">
      <div class="att-avatar" :style="{ background: store.user.color || '#6366f1' }">{{ store.user.name[0] }}</div>
      <h2>{{ store.user.name }}</h2>
      <div class="muted">{{ me.present ? 'Présent(e) depuis ' + time(me.since) : 'Vous n\\'êtes pas pointé(e)' }}</div>
      <div v-if="me.present" class="att-timer">{{ elapsedSince(me.since, now) }}</div>
      <button class="att-btn" :class="me.present ? 'out' : 'in'" :disabled="busy" @click="check">
        <Icon :name="me.present ? 'log-out' : 'log-in'"/>
        <span>{{ me.present ? 'Départ' : 'Arrivée' }}</span>
      </button>
      <transition name="fade"><div v-if="flash" class="att-flash" :class="flash">{{ flash === 'in' ? 'Bonne journée ! ☀️ Arrivée enregistrée' : 'Bonne soirée ! 👋 Départ enregistré' }}</div></transition>
      <div class="att-stats">
        <div><b>{{ hours(me.today_hours) }}</b><span>aujourd'hui</span></div>
        <div><b>{{ hours(me.week_hours) }}</b><span>cette semaine</span></div>
        <div><b>{{ hours(me.expected_today) }}</b><span>prévues aujourd'hui</span></div>
      </div>
      <div v-if="me.expected_today" class="att-progress"><i :style="{ width: progress + '%' }"></i></div>
    </div>

    <div v-if="tab === 'board'" class="att-board">
      <div v-for="u in team" :key="u.id" class="att-person card" :class="{ present: u.present }">
        <div class="att-avatar sm" :style="{ background: u.color }">{{ u.name[0] }}<i class="dot"></i></div>
        <div style="min-width:0">
          <b>{{ u.name }}</b>
          <div class="muted small">{{ u.job_title || ({ admin: 'Gérant', office: 'Bureau', mechanic: 'Mécanicien' })[u.role] }}</div>
          <div class="small" v-if="u.present">Présent depuis {{ time(u.since) }}<span v-if="u.working_on"> · sur {{ u.working_on }}</span></div>
          <div class="small muted" v-else>{{ u.first_in ? 'Parti · arrivé à ' + time(u.first_in) : 'Absent aujourd\\'hui' }}</div>
        </div>
        <div class="att-h">{{ hours(u.today_hours) }}</div>
      </div>
      <Empty v-if="!team.length" icon="👥" text="Aucun employé."/>
    </div>

    <template v-if="tab === 'report'">
      <div class="card">
        <div class="btns" style="align-items:flex-end;flex-wrap:wrap">
          <div class="seg"><button @click="setPeriod('today')">Aujourd'hui</button><button @click="setPeriod('week')">Cette semaine</button><button @click="setPeriod('lastweek')">Semaine dernière</button><button @click="setPeriod('month')">Ce mois</button></div>
          <label>Du<input type="date" v-model="period.from" @change="load"></label><label>Au<input type="date" v-model="period.to" @change="load"></label>
          <label>Employé<select v-model="period.user_id" @change="load"><option value="">Tous</option><option v-for="u in users" :value="u.id">{{ u.name }}</option></select></label>
          <span style="flex:1"></span>
          <button class="btn" @click="exportCsv"><Icon name="download"/> Export CSV</button>
          <button v-if="manager" class="btn primary" @click="newEntry">+ Ajouter un pointage</button>
        </div>
      </div>
      <div class="card">
        <table>
          <thead><tr><th>Employé</th><th class="num">Jours</th><th class="num">Heures prévues</th><th class="num">Heures travaillées</th><th class="num">Heures sup.</th><th class="num">Retards</th></tr></thead>
          <tbody><tr v-for="r in report" :key="r.user_id"><td><span class="avatar" :style="{ background: r.color }">{{ r.name[0] }}</span> {{ r.name }}</td><td class="num">{{ r.days }}</td><td class="num">{{ hours(r.expected) }}</td><td class="num"><b>{{ hours(r.worked) }}</b></td>
            <td class="num" :class="r.overtime >= 0 ? 'pos' : 'neg'">{{ r.overtime >= 0 ? '+' : '−' }}{{ hours(Math.abs(r.overtime)) }}</td><td class="num"><Badge v-if="r.late" :label="r.late" color="orange"/></td></tr></tbody>
          <tfoot><tr><td><b>Total</b></td><td></td><td class="num">{{ hours(totals.expected) }}</td><td class="num"><b>{{ hours(totals.worked) }}</b></td><td class="num">{{ totals.overtime >= 0 ? '+' : '−' }}{{ hours(Math.abs(totals.overtime)) }}</td><td></td></tr></tfoot>
        </table>
      </div>
      <div class="card">
        <div class="card-head"><h2>Détail des pointages</h2><span class="muted small" v-if="manager">Cliquez sur une ligne pour corriger</span></div>
        <table>
          <thead><tr><th>Employé</th><th>Date</th><th>Arrivée</th><th>Départ</th><th class="num">Heures</th><th>Origine</th><th>Note</th></tr></thead>
          <tbody><tr v-for="e in entries" :key="e.id" :class="{ click: manager }" @click="manager && (edit = { ...e })">
            <td><span class="avatar" :style="{ background: e.color }">{{ e.user_name[0] }}</span> {{ e.user_name }}</td><td>{{ date(e.start) }}</td><td>{{ e.start.slice(11, 16) }}</td>
            <td>{{ e.end ? e.end.slice(11, 16) : '' }}<Badge v-if="!e.end" label="en cours" color="green"/></td><td class="num">{{ hours(e.hours) }}</td>
            <td class="small muted">{{ ({ kiosk: 'Kiosque', badge: 'Badge', web: 'Ordinateur', manual: 'Correction' })[e.source] || 'Kiosque' }}</td><td class="small">{{ e.note }}</td></tr></tbody>
        </table>
        <Empty v-if="!entries.length" icon="🕘" text="Aucun pointage sur cette période."/>
      </div>
    </template>

    <Modal v-if="edit" :title="edit.id ? 'Corriger le pointage' : 'Ajouter un pointage'" @close="edit = null">
      <label v-if="!edit.id">Employé<select v-model="edit.user_id"><option v-for="u in users" :value="u.id">{{ u.name }}</option></select></label>
      <div class="form-grid">
        <label>Arrivée<input type="datetime-local" v-model="edit.start"></label>
        <label>Départ<input type="datetime-local" v-model="edit.end"></label>
      </div>
      <label>Note<input v-model="edit.note" placeholder="Ex. : oubli de pointage, rendez-vous médical…"></label>
      <template #foot><button v-if="edit.id" class="btn danger" @click="removeEntry">Supprimer</button><span style="flex:1"></span><button class="btn" @click="edit = null">Annuler</button><button class="btn primary" @click="saveEntry">Enregistrer</button></template>
    </Modal>
  </div>`,
};
