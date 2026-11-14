// Rapport du mois : activité de chaque mécanicien et de toute l'équipe (consultation, impression, envoi par e-mail).
import { ref, computed, onMounted } from 'vue';
import { GET, POST, act, toast, hours, date, today, store } from '../api.js';
import { gapLabel } from '../worktime.js';
import { can } from '../apps.js';
import { route } from '../router.js';

const STATE = { over: 'Dépassé', ok: 'Dans le temps', open: 'En cours', unplanned: 'Sans temps prévu', check: 'À vérifier' };

export const Reports = {
  setup() {
    const month = ref(/^\d{4}-\d{2}$/.test(route.query.month || '') ? route.query.month : today().slice(0, 7));
    const who = ref(route.query.user ? Number(route.query.user) : 0); // 0 = toute l'équipe
    const rep = ref(null);
    const error = ref('');
    const plan = ref(null);
    const sending = ref(false);
    const canSend = can('presences', 'manager');
    const load = async () => {
      error.value = '';
      try { rep.value = await GET('/timesheets/report?month=' + month.value); } catch (e) { rep.value = null; error.value = e.message; }
      if (who.value && !rep.value?.mechanics.some((m) => m.id === who.value)) who.value = 0;
    };
    onMounted(load);
    const lastMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); month.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); load(); };
    const thisMonth = () => { month.value = today().slice(0, 7); load(); };
    const one = computed(() => (who.value && rep.value ? rep.value.mechanics.find((m) => m.id === who.value) || null : null));
    const print = () => window.print();
    // ---------- Envoi par e-mail ----------
    const openSend = async () => { plan.value = await act(() => GET('/timesheets/report/plan?month=' + month.value)); };
    const result = (r) => {
      const n = r.delivery.filter((d) => d.status === 'sent').length;
      const no = r.delivery.filter((d) => d.status === 'no_email').map((d) => d.name);
      const ko = r.delivery.filter((d) => d.status === 'error');
      const already = r.delivery.filter((d) => d.status === 'already').length;
      if (n) toast(n + ' rapport(s) envoyé(s)');
      else if (!ko.length) toast(already ? 'Déjà envoyé pour ce mois (cochez « renvoyer » pour l’envoyer de nouveau)' : 'Aucun rapport à envoyer', 'error');
      if (no.length) toast('Pas d’adresse e-mail : ' + no.join(', '), 'error');
      if (ko.length) toast('Envoi en échec : ' + ko.map((d) => d.name + ' (' + d.error + ')').join(' · '), 'error');
    };
    const force = ref(false);
    const send = async (only) => {
      if (sending.value) return;
      sending.value = true;
      try {
        const r = await act(() => POST('/timesheets/report/send', { month: month.value, only: only || null, force: force.value }));
        result(r);
        plan.value = await GET('/timesheets/report/plan?month=' + month.value);
      } finally { sending.value = false; }
    };
    const sendAll = () => { if (confirm('Envoyer son rapport à chaque mécanicien et le rapport de l’équipe aux administrateurs ?')) send(null); };
    const lastLabel = (l) => (!l ? 'pas encore envoyé' : l.status === 'sent' ? 'envoyé le ' + date(l.sent_at.slice(0, 10)) + (l.auto ? ' (automatique)' : '') : 'échec : ' + (l.error || ''));
    const auto = computed(() => store.settings?.options?.atelier || {});
    return { month, who, rep, error, one, load, lastMonth, thisMonth, print, plan, openSend, send, sendAll, sending, force, canSend, lastLabel, auto, hours, date, gapLabel, STATE };
  },
  template: `
  <div class="report-page">
    <div class="page-head">
      <div><h1>Rapport du mois</h1><div class="sub">Activité de l'atelier : présence, heures sur les OR, temps prévu et temps passé par intervention.</div></div>
      <div class="toolbar no-print" style="margin:0">
        <input type="month" v-model="month" @change="load" style="max-width:170px">
        <button class="btn sm" @click="thisMonth">Ce mois-ci</button><button class="btn sm" @click="lastMonth">Mois dernier</button>
        <select v-model.number="who" style="width:auto"><option :value="0">Toute l'équipe</option><option v-for="m in (rep ? rep.mechanics : [])" :key="m.id" :value="m.id">{{ m.name }}</option></select>
        <button class="btn" @click="print">🖨️ Imprimer</button>
        <button v-if="canSend" class="btn primary" @click="openSend">✉️ Envoyer par e-mail</button>
      </div>
    </div>
    <div v-if="error" class="card"><Empty icon="🗓️" :text="error"/></div>
    <template v-else-if="rep">
      <div class="card">
        <div class="card-head"><h2 style="text-transform:capitalize">{{ one ? one.name + ' — ' : 'Atelier — ' }}{{ rep.label }}</h2>
          <span class="small muted">du {{ date(rep.from) }} au {{ date(rep.to) }}<template v-if="!rep.complete"> · mois en cours</template></span></div>

        <!-- Toute l'équipe -->
        <template v-if="!one">
          <div class="table-wrap"><table class="wt-table">
            <thead><tr><th>Mécanicien</th><th class="num">Jours</th><th class="num">Présence</th><th class="num">Heures sur OR</th><th class="num">Interventions</th><th class="num">Prévu</th><th class="num">Passé</th><th class="num">Écart</th><th class="num">Dépassements</th></tr></thead>
            <tbody>
              <tr v-for="m in rep.mechanics" :key="m.id" class="click" @click="who = m.id">
                <td><span style="display:inline-flex;gap:8px;align-items:center"><span class="avatar" :style="{ background: m.color, width: '24px', height: '24px', fontSize: '11px' }">{{ m.name[0] }}</span>{{ m.name }}<span v-if="m.inactive" class="muted small">(inactif)</span></span></td>
                <td class="num">{{ m.days }}</td><td class="num">{{ hours(m.presence) }}</td>
                <td class="num">{{ hours(m.work) }}<span v-if="m.productivity !== null" class="muted small"> · {{ m.productivity }} %</span></td>
                <td class="num">{{ m.interventions }}</td>
                <td class="num">{{ m.interventions ? hours(m.planned) : '—' }}</td><td class="num">{{ m.interventions ? hours(m.spent) : '—' }}</td>
                <td class="num"><b v-if="m.interventions" :class="m.gap > 0.005 ? 'neg' : 'pos'">{{ gapLabel(m.gap) }}</b><span v-else class="muted">—</span></td>
                <td class="num"><b v-if="m.overruns" class="wt-over">{{ m.overruns }}</b><span v-else class="muted">0</span><span v-if="m.to_check" class="warn small"> · {{ m.to_check }} à vérifier</span></td>
              </tr>
            </tbody>
            <tfoot v-if="rep.mechanics.length > 1"><tr>
              <td><b>Total équipe</b></td><td></td><td class="num"><b>{{ hours(rep.totals.presence) }}</b></td>
              <td class="num"><b>{{ hours(rep.totals.work) }}</b><span v-if="rep.totals.productivity !== null" class="muted small"> · {{ rep.totals.productivity }} %</span></td>
              <td class="num"><b>{{ rep.totals.interventions }}</b></td><td class="num"><b>{{ hours(rep.totals.planned) }}</b></td><td class="num"><b>{{ hours(rep.totals.spent) }}</b></td>
              <td class="num"><b :class="rep.totals.gap > 0.005 ? 'neg' : 'pos'">{{ gapLabel(rep.totals.gap) }}</b></td>
              <td class="num"><b :class="{ 'wt-over': rep.totals.overruns }">{{ rep.totals.overruns }}</b></td>
            </tr></tfoot>
          </table></div>
          <Empty v-if="!rep.mechanics.length" icon="🔧" text="Aucun mécanicien sur ce mois"/>
        </template>

        <!-- Un mécanicien -->
        <template v-else>
          <div class="grid g4 report-kpis">
            <div class="kpi"><div class="l">Présence</div><div class="v">{{ hours(one.presence) }}</div><div class="muted small">{{ one.days }} jour(s) travaillé(s)<template v-if="one.late"> · {{ one.late }} retard(s)</template></div></div>
            <div class="kpi"><div class="l">Heures sur OR</div><div class="v">{{ hours(one.work) }}</div><div class="muted small" v-if="one.productivity !== null">{{ one.productivity }} % du temps de présence</div></div>
            <div class="kpi"><div class="l">Prévu / passé</div><div class="v">{{ one.interventions ? hours(one.planned) + ' / ' + hours(one.spent) : '—' }}</div>
              <div class="small" v-if="one.interventions"><b :class="one.gap > 0.005 ? 'neg' : 'pos'">{{ gapLabel(one.gap) }}</b> sur {{ one.interventions }} intervention(s)</div></div>
            <div class="kpi" :class="{ alert: one.overruns }"><div class="l">Dépassements</div><div class="v">{{ one.overruns }}</div><div class="warn small" v-if="one.to_check">{{ one.to_check }} intervention(s) à vérifier</div></div>
          </div>
          <div class="table-wrap" v-if="one.rows.length"><table class="wt-table">
            <thead><tr><th>Date</th><th>OR</th><th>Intervention</th><th class="num">Prévu</th><th class="num">Passé</th><th class="num">Écart</th><th>Résultat</th></tr></thead>
            <tbody><tr v-for="(r, i) in one.rows" :key="i">
              <td>{{ date(r.date) }}</td>
              <td><a :href="'#/document/' + r.document_id">{{ r.number }}</a> <span class="plate" v-if="r.plate">{{ r.plate }}</span></td>
              <td>{{ r.description }}<div v-if="r.with" class="small muted">avec {{ r.with }}</div></td>
              <td class="num">{{ r.planned !== null ? hours(r.planned) : '—' }}</td>
              <td class="num"><b :class="{ 'wt-over': r.state === 'over' }">{{ hours(r.spent) }}</b></td>
              <td class="num"><b v-if="r.gap !== null" :class="r.gap > 0.005 ? 'wt-over' : 'pos'">{{ gapLabel(r.gap) }}</b><span v-else class="muted">—</span></td>
              <td><span class="badge" :class="{ 'b-red': r.state === 'over', 'b-green': r.state === 'ok', 'b-gray': r.state === 'open' || r.state === 'unplanned', 'b-orange': r.state === 'check' }">{{ STATE[r.state] }}</span></td>
            </tr></tbody>
          </table></div>
          <Empty v-else icon="⏱️" text="Aucune intervention chronométrée ce mois-ci"/>
        </template>
      </div>

      <template v-if="!one">
        <div class="card" v-if="rep.overruns.length">
          <div class="card-head"><h2>Interventions en dépassement</h2><span class="small muted">{{ rep.overruns.length }} ce mois-ci</span></div>
          <div class="table-wrap"><table class="wt-table">
            <thead><tr><th>Intervention</th><th>OR</th><th>Mécanicien(s)</th><th class="num">Prévu</th><th class="num">Passé</th><th class="num">Écart</th></tr></thead>
            <tbody><tr v-for="(u, i) in rep.overruns" :key="i">
              <td>{{ u.description }}</td><td><a :href="'#/document/' + u.document_id">{{ u.number }}</a> <span class="plate" v-if="u.plate">{{ u.plate }}</span></td><td>{{ u.mechanics }}</td>
              <td class="num">{{ hours(u.planned) }}</td><td class="num"><b class="wt-over">{{ hours(u.spent) }}</b></td><td class="num"><b class="wt-over">{{ gapLabel(u.over) }}</b></td>
            </tr></tbody>
          </table></div>
        </div>
        <div class="card" v-if="rep.to_check.length">
          <div class="card-head"><h2>À vérifier</h2><span class="small muted">chrono oublié, arrêté automatiquement</span></div>
          <div v-for="(u, i) in rep.to_check" :key="i" class="list-item"><span>{{ u.description }} · <a :href="'#/document/' + u.document_id">{{ u.number }}</a> · {{ u.mechanics }}</span><span class="warn">{{ hours(u.spent) }} enregistrées</span></div>
          <p class="small muted" style="margin:8px 0 0">Corrigez leurs heures dans <a href="#/timesheets">Feuilles de temps</a> : elles seront alors comptées normalement.</p>
        </div>
      </template>
      <p class="small muted">« Prévu » : temps prévu par le garage pour l'intervention. « Passé » : temps pointé à la tablette. À plusieurs sur une intervention, le temps prévu est partagé selon le temps de chacun. Une intervention est comptée le mois du dernier pointage dessus.</p>
    </template>

    <Modal v-if="plan" :title="'Envoyer les rapports de ' + plan.label" wide @close="plan = null">
      <div v-if="!plan.mail_configured" class="notice warn">L'envoi d'e-mails n'est pas encore configuré : <a href="#/settings?tab=mail" @click="plan = null">Paramètres → E-mails</a>.</div>
      <p v-if="!plan.complete" class="small warn">Ce mois n'est pas terminé : le rapport s'arrête à aujourd'hui.</p>
      <h3>Chaque mécanicien reçoit son propre rapport</h3>
      <div v-for="m in plan.mechanics" :key="m.id" class="list-item">
        <div><b>{{ m.name }}</b><div class="small" :class="m.email ? 'muted' : 'warn'">{{ m.email || 'pas d’adresse e-mail (Paramètres → Utilisateurs)' }}</div></div>
        <div class="right small"><span :class="m.last && m.last.status !== 'sent' ? 'neg' : 'muted'">{{ lastLabel(m.last) }}</span>
          <div><button class="btn sm" :disabled="sending || !m.email || !m.active || !plan.mail_configured" @click="send({ mechanic: m.id })">Envoyer</button></div></div>
      </div>
      <Empty v-if="!plan.mechanics.length" icon="🔧" text="Aucun mécanicien sur ce mois"/>
      <h3 style="margin-top:16px">Le rapport de toute l'équipe</h3>
      <div v-for="r in plan.team" :key="r.email" class="list-item">
        <div><b>{{ r.name }}</b><div class="small muted">{{ r.email }}</div></div>
        <span class="small" :class="r.last && r.last.status !== 'sent' ? 'neg' : 'muted'">{{ lastLabel(r.last) }}</span>
      </div>
      <p v-if="!plan.team.length" class="small warn">Aucun administrateur n'a d'adresse e-mail : ajoutez-la dans Paramètres → Utilisateurs.</p>
      <p class="small muted" style="margin-top:12px">Envoi automatique chaque début de mois : <b>{{ auto.monthly_report ? 'activé (à ' + (auto.monthly_report_time || '07:00') + ', pour le mois écoulé)' : 'désactivé' }}</b> — Paramètres → Configuration → Atelier.</p>
      <template #foot>
        <label class="small" style="margin-right:auto;display:flex;gap:6px;align-items:center"><input type="checkbox" v-model="force" style="width:auto"> renvoyer même si déjà envoyé</label>
        <button class="btn" :disabled="sending || !plan.mail_configured || !plan.team.length" @click="send({ team: true })">Rapport d'équipe seulement</button>
        <button class="btn primary" :disabled="sending || !plan.mail_configured" @click="sendAll">{{ sending ? 'Envoi…' : 'Tout envoyer' }}</button>
      </template>
    </Modal>
  </div>`,
};
