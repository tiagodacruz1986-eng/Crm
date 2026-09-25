import { ref, onMounted, onUnmounted } from 'vue';
import { GET, money, date, time, store } from '../api.js';

export const Dashboard = {
  setup() {
    const d = ref(null);
    const load = async () => { d.value = await GET('/dashboard'); };
    let t;
    onMounted(() => { load(); t = setInterval(load, 30000); });
    onUnmounted(() => clearInterval(t));
    const hello = new Date().getHours() < 12 ? 'Bonjour' : new Date().getHours() < 18 ? 'Bon après-midi' : 'Bonsoir';
    const monthLabel = (m) => new Date(m + '-15').toLocaleDateString('fr-LU', { month: 'short' });
    return { d, money, date, time, store, hello, monthLabel };
  },
  template: `
  <div v-if="d">
    <div class="page-head">
      <div><h1>{{ hello }} {{ store.user.name.split(' ')[0] }} 👋</h1><div class="sub">{{ new Date().toLocaleDateString('fr-LU', {weekday:'long', day:'numeric', month:'long'}) }}</div></div>
      <div class="btns"><ModuleTools module="general"/><a class="btn" href="#/office">🤖 Demander à mon équipe IA</a></div>
    </div>
    <div class="grid g4">
      <div class="kpi"><div class="l">💶 CA du mois (HT)</div><div class="v">{{ money(d.salesMonth) }}</div><div class="muted small">Année : {{ money(d.salesYear) }}</div></div>
      <a class="kpi click" href="#/workshop"><div class="l">🔧 OR en cours</div><div class="v">{{ d.ordersOpen }}</div><div class="muted small">{{ d.quotesPending }} devis en attente</div></a>
      <a class="kpi click" :class="{alert: d.overdue > 0}" href="#/documents/invoice?filter=overdue"><div class="l">⏰ À encaisser</div><div class="v">{{ money(d.receivable) }}</div><div class="small" :class="d.overdue > 0 ? 'neg' : 'muted'">dont {{ money(d.overdue) }} en retard</div></a>
      <a class="kpi click" href="#/bank"><div class="l">🏦 Trésorerie</div><div class="v">{{ money(d.bank) }}</div><div class="muted small">{{ d.unmatchedBank }} opérations à rapprocher · fournisseurs {{ money(d.payable) }}</div></a>
    </div>
    <div class="grid g3" style="margin-top:16px">
      <div class="card" style="grid-column: span 2">
        <div class="card-head"><h2>Chiffre d'affaires (12 mois)</h2></div>
        <BarChart :data="d.monthly.map(m => ({...m, label: monthLabel(m.month)}))" value-key="total" label-key="label" :format="v => Math.round(v/100)/10 + 'k'"/>
      </div>
      <div class="card">
        <div class="card-head"><h2>À l'atelier maintenant</h2><a href="#/timesheets" class="small">Pointage →</a></div>
        <div v-for="p in d.present" class="list-item">
          <div style="display:flex;gap:8px;align-items:center"><span class="avatar" :style="{background: p.color}">{{ p.name[0] }}</span>{{ p.name }}</div>
          <span v-if="p.working_on" class="live">{{ p.working_on }}</span><span v-else class="muted small">présent</span>
        </div>
        <Empty v-if="!d.present.length" icon="😴" text="Aucun mécanicien pointé"/>
      </div>
    </div>
    <div class="grid g3" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><h2>📅 Rendez-vous du jour</h2><a href="#/planning" class="small">Planning →</a></div>
        <div v-for="a in d.appointmentsToday" class="list-item">
          <div><b>{{ time(a.start) }}</b> <span class="plate" v-if="a.plate">{{ a.plate }}</span> {{ a.customer_name }}<div class="muted small">{{ a.title }}</div></div>
          <Badge :status="a.status"/>
        </div>
        <Empty v-if="!d.appointmentsToday.length" icon="☕" text="Pas de rendez-vous aujourd'hui"/>
      </div>
      <div class="card">
        <div class="card-head"><h2>📦 Stock bas</h2><a href="#/stock?low=1" class="small">Voir →</a></div>
        <div v-for="p in d.lowStock" class="list-item"><a :href="'#/product/' + p.id">{{ p.ref }} {{ p.name }}</a><span class="neg">{{ p.qty_on_hand }} / {{ p.qty_min }}</span></div>
        <Empty v-if="!d.lowStock.length" icon="✅" text="Stock OK"/>
      </div>
      <div class="card">
        <div class="card-head"><h2>🔔 Contrôles techniques (30 j)</h2></div>
        <div v-for="v in d.inspectionsSoon" class="list-item">
          <a :href="'#/vehicle/' + v.id"><span class="plate">{{ v.plate }}</span> {{ v.make }} {{ v.model }}</a>
          <div class="right small">{{ date(v.next_inspection) }}<div class="muted">{{ v.customer_name }} {{ v.mobile || v.phone }}</div></div>
        </div>
        <Empty v-if="!d.inspectionsSoon.length" icon="🗓️" text="Aucune échéance proche"/>
      </div>
    </div>
  </div>`,
};
