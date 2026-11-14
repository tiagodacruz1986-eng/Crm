import { ref, computed, onMounted, onUnmounted } from 'vue';
import { GET, money, date, time, hours, store } from '../api.js';
import { BriefCard } from '../copilot.js';
import { MechanicStats } from '../worktime.js';
import { can } from '../apps.js';
import { theme } from '../theme.js';

export const Dashboard = {
  components: { BriefCard, MechanicStats },
  setup() {
    const d = ref(null);
    const load = async () => { d.value = await GET('/dashboard'); };
    let t;
    onMounted(() => { load(); t = setInterval(load, 30000); });
    onUnmounted(() => clearInterval(t));
    const hello = new Date().getHours() < 12 ? 'Bonjour' : new Date().getHours() < 18 ? 'Bon après-midi' : 'Bonsoir';
    const monthLabel = (m) => new Date(m + '-15').toLocaleDateString('fr-LU', { month: 'short' });
    // ---------- Thème « Verre » : widgets flottants comme sur visionOS ----------
    const glass = computed(() => theme.pref === 'glass');
    const firstName = computed(() => (store.user?.name || '').split(' ')[0]);
    const today = new Date().toLocaleDateString('fr-LU', { weekday: 'long', day: 'numeric', month: 'long' });
    const months = computed(() => (d.value?.monthly || []).map((m) => ({ ...m, total: Number(m.total) || 0 })));
    // Huit derniers mois en barres (le mois en cours hachuré), initiale du mois dessous
    const recent = computed(() => {
      const list = months.value.slice(-8);
      const max = Math.max(1, ...list.map((m) => m.total));
      return list.map((m, i) => ({ h: Math.max(6, Math.round((100 * m.total) / max)), letter: monthLabel(m.month).charAt(0).toUpperCase(), now: i === list.length - 1, title: monthLabel(m.month) + ' : ' + money(m.total) }));
    });
    // Évolution du mois en cours par rapport au mois précédent (vrais chiffres, rien d'inventé)
    const trend = computed(() => {
      // Pas de comparaison les premiers jours du mois (le mois en cours vient de commencer)
      const m = months.value; if (m.length < 2 || !m[m.length - 2].total || new Date().getDate() < 8) return null;
      return Math.round(((m[m.length - 1].total - m[m.length - 2].total) / m[m.length - 2].total) * 100);
    });
    const yearTotal = computed(() => months.value.reduce((t, m) => t + m.total, 0));
    // Courbe lissée des 12 mois (carte sombre)
    const curve = computed(() => {
      const v = months.value.map((m) => m.total); if (v.length < 2) return null;
      const W = 300, H = 120, max = Math.max(1, ...v), pts = v.map((y, i) => [(i * W) / (v.length - 1), H - 8 - ((H - 24) * y) / max]);
      let line = `M${pts[0][0]},${pts[0][1]}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[Math.max(0, i - 1)], [x1, y1] = pts[i], [x2, y2] = pts[i + 1], [x3, y3] = pts[Math.min(pts.length - 1, i + 2)];
        line += ` C${x1 + (x2 - x0) / 6},${y1 + (y2 - y0) / 6} ${x2 - (x3 - x1) / 6},${y2 - (y3 - y1) / 6} ${x2},${y2}`;
      }
      const last = pts[pts.length - 1];
      return { line, area: `${line} L${W},${H} L0,${H} Z`, x: last[0], y: last[1] };
    });
    const overdueShare = computed(() => (d.value?.receivable ? Math.min(100, Math.round((100 * d.value.overdue) / d.value.receivable)) : 0));
    // Statistiques des mécaniciens : réservées à ceux qui ont le droit Présences (comme les feuilles de temps)
    const showMech = can('presences');
    return { showMech, hours, d, money, date, time, store, hello, monthLabel, glass, firstName, today, recent, trend, yearTotal, curve, overdueShare };
  },
  template: `
  <div v-if="d && glass" class="gdash">
    <div class="gd-main">
      <div class="page-head">
        <div><h1>{{ hello }}, {{ firstName }}</h1><div class="sub" style="text-transform:capitalize">{{ today }}</div></div>
        <div class="btns"><ModuleTools module="general"/><a class="btn" href="#/office"><Icon name="bot"/> Mon équipe IA</a></div>
      </div>
      <BriefCard/>
      <div class="gd-tiles">
        <a v-if="d.ordersOpen !== null" class="kpi click" href="#/workshop"><div class="l"><Icon name="wrench"/> OR en cours</div><div class="v">{{ d.ordersOpen }}</div><span v-if="d.quotesPending !== null" class="gchip">{{ d.quotesPending }} devis en attente</span></a>
        <a v-if="d.receivable !== null" class="kpi click" :class="{ alert: d.overdue > 0 }" href="#/documents/invoice?filter=overdue"><div class="l"><Icon name="wallet"/> À encaisser</div><div class="v">{{ money(d.receivable) }}</div>
          <div class="gbars" :title="overdueShare + ' % en retard'"><i :style="{ width: overdueShare + '%' }"></i></div><div class="small" :class="d.overdue > 0 ? 'neg' : 'muted'">dont {{ money(d.overdue) }} en retard</div></a>
        <a v-if="d.payable !== null && d.payable !== undefined" class="kpi click" href="#/purchases"><div class="l"><Icon name="shopping-cart"/> Fournisseurs à payer</div><div class="v">{{ money(d.payable) }}</div><span class="gchip">achats validés</span></a>
        <a v-if="d.unmatchedBank !== null && d.unmatchedBank !== undefined" class="kpi click" href="#/bank"><div class="l"><Icon name="landmark"/> À rapprocher</div><div class="v">{{ d.unmatchedBank }}</div><span class="gchip">opérations bancaires</span></a>
      </div>
      <div class="gd-row">
        <div class="card">
          <div class="card-head"><h2>À l'atelier maintenant</h2><a href="#/timesheets" class="small">Pointage →</a></div>
          <div v-for="p in d.present" class="list-item">
            <div style="display:flex;gap:10px;align-items:center;min-width:0;flex:1"><span class="gsq" :style="{ background: p.color }"></span><div style="min-width:0;flex:1">{{ p.name }}<div v-if="p.work && p.work.line" class="muted small wt-clip">{{ p.work.line }}</div></div></div>
            <a v-if="p.work" class="live" :class="{ over: p.work.over }" :href="'#/document/' + p.work.document_id" :title="p.work.over ? 'Temps prévu dépassé' : ''">{{ p.work.number }} · {{ hours(p.work.spent) }}<template v-if="p.work.planned"> / {{ hours(p.work.planned) }}</template></a>
            <span v-else class="muted small">présent</span>
          </div>
          <Empty v-if="!d.present.length" icon="😴" text="Aucun mécanicien pointé"/>
        </div>
        <div class="card">
          <div class="card-head"><h2>Rendez-vous du jour</h2><a href="#/planning" class="small">Planning →</a></div>
          <div v-for="a in d.appointmentsToday" class="list-item">
            <div><b>{{ time(a.start) }}</b> <span class="plate" v-if="a.plate">{{ a.plate }}</span> {{ a.customer_name }}<div class="muted small">{{ a.title }}</div></div>
            <Badge :status="a.status"/>
          </div>
          <Empty v-if="!d.appointmentsToday.length" icon="☕" text="Pas de rendez-vous aujourd'hui"/>
        </div>
      </div>
      <MechanicStats v-if="showMech" style="margin-top:14px"/>
      <div class="gd-row">
        <div class="card">
          <div class="card-head"><h2>Stock bas</h2><a href="#/stock?low=1" class="small">Voir →</a></div>
          <div v-for="p in d.lowStock" class="list-item"><a :href="'#/product/' + p.id">{{ p.ref }} {{ p.name }}</a><span class="neg">{{ p.qty_on_hand }} / {{ p.qty_min }}</span></div>
          <Empty v-if="!d.lowStock.length" icon="✅" text="Stock OK"/>
        </div>
        <div class="card">
          <div class="card-head"><h2>Contrôles techniques (30 j)</h2></div>
          <div v-for="v in d.inspectionsSoon" class="list-item">
            <a :href="'#/vehicle/' + v.id"><span class="plate">{{ v.plate }}</span> {{ v.make }} {{ v.model }}</a>
            <div class="right small">{{ date(v.next_inspection) }}<div class="muted">{{ v.customer_name }} {{ v.mobile || v.phone }}</div></div>
          </div>
          <Empty v-if="!d.inspectionsSoon.length" icon="🗓️" text="Aucune échéance proche"/>
        </div>
      </div>
    </div>
    <aside class="gd-side">
      <a v-if="d.salesMonth !== null" class="gw gw-blue" href="#/documents/invoice">
        <div class="gw-head"><span>Chiffre d'affaires</span><Icon name="trending-up"/></div>
        <div class="gw-v">{{ money(d.salesMonth) }}</div>
        <div class="gw-sub">ce mois-ci (HT) <span v-if="trend !== null" class="gchip">{{ trend > 0 ? '↗ +' : trend < 0 ? '↘ ' : '' }}{{ trend }} %</span></div>
        <div class="gw-bars"><div v-for="(b, i) in recent" :key="i" class="gw-bar" :title="b.title"><i :class="{ now: b.now }" :style="{ height: b.h + '%' }"></i><small>{{ b.letter }}</small></div></div>
      </a>
      <a v-if="d.bank !== null" class="gw gw-glass" href="#/bank">
        <div class="gw-head"><span><Icon name="landmark"/> Trésorerie</span><Icon name="external-link"/></div>
        <div class="gw-v">{{ money(d.bank) }}</div>
        <div class="gw-sub">{{ d.unmatchedBank }} opération(s) à rapprocher</div>
      </a>
      <div v-if="d.salesMonth !== null" class="gw gw-dark">
        <div class="gw-head"><span>CA sur 12 mois</span><span class="gchip">12 mois</span></div>
        <div class="gw-v">{{ money(yearTotal) }}</div>
        <div class="gw-sub">Année en cours : {{ money(d.salesYear) }}</div>
        <svg v-if="curve" class="gw-curve" viewBox="0 0 300 120" preserveAspectRatio="none" aria-label="Évolution du chiffre d'affaires sur 12 mois">
          <defs><linearGradient id="gwfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
          <path :d="curve.area" fill="url(#gwfill)"/><path :d="curve.line" fill="none" stroke="#fff" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
          <circle :cx="curve.x" :cy="curve.y" r="5" fill="#fff"/>
        </svg>
      </div>
    </aside>
  </div>
  <div v-else-if="d">
    <div class="page-head">
      <div><h1>{{ hello }} {{ store.user.name.split(' ')[0] }} 👋</h1><div class="sub">{{ new Date().toLocaleDateString('fr-LU', {weekday:'long', day:'numeric', month:'long'}) }}</div></div>
      <div class="btns"><ModuleTools module="general"/><a class="btn" href="#/office"><Icon name="bot"/> Mon équipe IA</a></div>
    </div>
    <BriefCard/>
    <div class="grid g4">
      <div v-if="d.salesMonth !== null" class="kpi"><div class="l"><Icon name="trending-up"/> CA du mois (HT)</div><div class="v">{{ money(d.salesMonth) }}</div><div class="muted small">Année : {{ money(d.salesYear) }}</div></div>
      <a v-if="d.ordersOpen !== null" class="kpi click" href="#/workshop"><div class="l"><Icon name="wrench"/> OR en cours</div><div class="v">{{ d.ordersOpen }}</div><div v-if="d.quotesPending !== null" class="muted small">{{ d.quotesPending }} devis en attente</div></a>
      <a v-if="d.receivable !== null" class="kpi click" :class="{alert: d.overdue > 0}" href="#/documents/invoice?filter=overdue"><div class="l"><Icon name="wallet"/> À encaisser</div><div class="v">{{ money(d.receivable) }}</div><div class="small" :class="d.overdue > 0 ? 'neg' : 'muted'">dont {{ money(d.overdue) }} en retard</div></a>
      <a v-if="d.bank !== null" class="kpi click" href="#/bank"><div class="l"><Icon name="landmark"/> Trésorerie</div><div class="v">{{ money(d.bank) }}</div><div class="muted small">{{ d.unmatchedBank }} opérations à rapprocher · fournisseurs {{ money(d.payable) }}</div></a>
    </div>
    <div class="grid g3" style="margin-top:16px">
      <div v-if="d.monthly.length" class="card" style="grid-column: span 2">
        <div class="card-head"><h2>Chiffre d'affaires (12 mois)</h2></div>
        <BarChart :data="d.monthly.map(m => ({...m, label: monthLabel(m.month)}))" value-key="total" label-key="label" :format="v => v ? Math.round(v/100)/10 + 'k' : ''"/>
      </div>
      <div class="card">
        <div class="card-head"><h2>À l'atelier maintenant</h2><a href="#/timesheets" class="small">Pointage →</a></div>
        <div v-for="p in d.present" class="list-item">
          <div style="display:flex;gap:8px;align-items:center;min-width:0;flex:1"><span class="avatar" :style="{background: p.color}">{{ p.name[0] }}</span><div style="min-width:0;flex:1">{{ p.name }}<div v-if="p.work && p.work.line" class="muted small wt-clip">{{ p.work.line }}</div></div></div>
          <a v-if="p.work" class="live" :class="{ over: p.work.over }" :href="'#/document/' + p.work.document_id" :title="p.work.over ? 'Temps prévu dépassé' : ''">{{ p.work.number }} · {{ hours(p.work.spent) }}<template v-if="p.work.planned"> / {{ hours(p.work.planned) }}</template></a>
          <span v-else class="muted small">présent</span>
        </div>
        <Empty v-if="!d.present.length" icon="😴" text="Aucun mécanicien pointé"/>
      </div>
    </div>
    <MechanicStats v-if="showMech" style="margin-top:16px"/>
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
