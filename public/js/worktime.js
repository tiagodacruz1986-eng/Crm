// Temps atelier : statistiques par mécanicien (heures sur OR, temps prévu / temps passé, dépassements).
// Affiché sur le tableau de bord et dans les feuilles de temps.
import { ref, onMounted, onUnmounted } from 'vue';
import { GET, hours, today, addDays } from './api.js';

const PERIODS = [['day', "Aujourd'hui"], ['week', 'Cette semaine'], ['month', 'Ce mois-ci']];
/** Début et fin de la période choisie (jusqu'à aujourd'hui). */
export function periodRange(period) {
  const t = today();
  if (period === 'week') return [addDays(t, -((new Date().getDay() + 6) % 7)), t];
  if (period === 'month') return [t.slice(0, 8) + '01', t];
  return [t, t];
}
/** Écart entre temps passé et temps prévu : « + 0h30 » (plus long que prévu) ou « − 0h15 » (plus court). */
export const gapLabel = (g) => (Math.abs(g) < 0.005 ? '0h00' : (g > 0 ? '+ ' : '− ') + hours(Math.abs(g)));

export const MechanicStats = {
  setup() {
    const period = ref('week');
    const data = ref(null);
    const load = async () => {
      const [from, to] = periodRange(period.value);
      try { data.value = await GET(`/timesheets/stats?from=${from}&to=${to}`); } catch { /* droit retiré ou serveur injoignable : la carte reste telle quelle */ }
    };
    const setPeriod = (k) => { period.value = k; load(); };
    let t;
    onMounted(() => { load(); t = setInterval(load, 30000); });
    onUnmounted(() => clearInterval(t));
    return { PERIODS, period, data, setPeriod, hours, gapLabel };
  },
  template: `
  <div class="card" v-if="data">
    <div class="card-head">
      <h2>Mécaniciens : temps prévu et temps passé</h2>
      <div class="wt-chips"><button v-for="[k, label] in PERIODS" :key="k" :class="{ on: period === k }" @click="setPeriod(k)">{{ label }}</button></div>
    </div>
    <div class="table-wrap" v-if="data.mechanics.length"><table class="wt-table">
      <thead><tr><th>Mécanicien</th><th>En ce moment</th><th class="num">Heures sur OR</th><th class="num">Interventions</th><th class="num">Prévu</th><th class="num">Passé</th><th class="num">Écart</th><th class="num">Dépassements</th></tr></thead>
      <tbody>
        <tr v-for="m in data.mechanics" :key="m.id">
          <td><span style="display:inline-flex;gap:8px;align-items:center"><span class="avatar" :style="{ background: m.color, width: '24px', height: '24px', fontSize: '11px' }">{{ m.name[0] }}</span>{{ m.name }}</span></td>
          <td>
            <span v-if="m.current" class="wt-cur">
              <a :href="'#/document/' + m.current.document_id">{{ m.current.number }}</a>
              <span v-if="m.current.line" class="small muted"> · {{ m.current.line }}</span>
              <b class="small" :class="{ 'wt-over': m.current.over }"> · {{ hours(m.current.spent) }}<template v-if="m.current.planned"> / {{ hours(m.current.planned) }}</template></b>
            </span>
            <span v-else class="muted small">—</span>
          </td>
          <td class="num">{{ hours(m.work) }}</td>
          <td class="num">{{ m.interventions }}</td>
          <td class="num">{{ m.interventions ? hours(m.planned) : '—' }}</td>
          <td class="num">{{ m.interventions ? hours(m.spent) : '—' }}</td>
          <td class="num"><b v-if="m.interventions" :class="m.gap > 0.005 ? 'neg' : 'pos'">{{ gapLabel(m.gap) }}</b><span v-else class="muted">—</span></td>
          <td class="num"><b v-if="m.overruns" class="wt-over">{{ m.overruns }}</b><span v-else class="muted">0</span></td>
        </tr>
      </tbody>
    </table></div>
    <Empty v-else icon="🔧" text="Aucun mécanicien"/>
    <div class="small muted" style="margin-top:10px">Interventions terminées (ou déjà en dépassement) sur la période. En rouge : le temps prévu est dépassé. <a href="#/timesheets">Détail par intervention →</a></div>
  </div>`,
};
