import { ref, reactive, computed, onMounted } from 'vue';
import { GET, POST, act, money, date, today } from '../api.js';
import { route } from '../router.js';

const TYPE_LABEL = { asset: 'Actif', liability: 'Passif', equity: 'Capitaux', income: 'Produit', expense: 'Charge' };

export const Accounting = {
  setup() {
    const y = today().slice(0, 4);
    const p = reactive({ from: `${y}-01-01`, to: today() });
    const tab = ref(route.query.tab || 'moves');
    const data = ref(null);
    const journal = ref('');
    const ledgerCode = ref('4011');
    const accounts = ref([]);
    const od = ref(null);
    const load = async () => {
      data.value = null;
      const qs = `from=${p.from}&to=${p.to}`;
      if (tab.value === 'moves') data.value = await GET(`/accounting/moves?${qs}${journal.value ? '&journal=' + journal.value : ''}`);
      if (tab.value === 'balance') data.value = await GET(`/accounting/balance?${qs}`);
      if (tab.value === 'ledger') data.value = await GET(`/accounting/ledger/${ledgerCode.value}?${qs}`);
      if (tab.value === 'vat') data.value = await GET(`/accounting/vat?${qs}`);
      if (tab.value === 'pnl') data.value = await GET(`/accounting/pnl?${qs}`);
      if (tab.value === 'aged') data.value = await GET('/accounting/aged');
    };
    onMounted(async () => { accounts.value = await GET('/accounting/accounts'); load(); });
    const setTab = (t) => { tab.value = t; load(); };
    const preset = (k) => {
      const d = new Date();
      const m = d.getMonth();
      const pad = (n) => String(n).padStart(2, '0');
      if (k === 'month') { p.from = `${y}-${pad(m + 1)}-01`; p.to = today(); }
      if (k === 'lastmonth') { const s = new Date(d.getFullYear(), m - 1, 1), e = new Date(d.getFullYear(), m, 0); p.from = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-01`; p.to = `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}`; }
      if (k === 'quarter') { const q = Math.floor(m / 3) * 3; p.from = `${y}-${pad(q + 1)}-01`; p.to = today(); }
      if (k === 'year') { p.from = `${y}-01-01`; p.to = today(); }
      if (k === 'lastyear') { p.from = `${y - 1}-01-01`; p.to = `${y - 1}-12-31`; }
      load();
    };
    const balTotals = computed(() => Array.isArray(data.value) && tab.value === 'balance'
      ? data.value.reduce((s, r) => ({ d: s.d + r.debit, c: s.c + r.credit }), { d: 0, c: 0 }) : null);
    const openLedger = (code) => { ledgerCode.value = code; setTab('ledger'); };
    const newOd = () => { od.value = { date: today(), label: '', lines: [{ account_code: '', debit: 0, credit: 0 }, { account_code: '', debit: 0, credit: 0 }] }; };
    const odBalance = computed(() => od.value ? Math.round(od.value.lines.reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0) * 100) / 100 : 0);
    const saveOd = async () => { await act(() => POST('/accounting/moves', od.value), 'Écriture enregistrée'); od.value = null; load(); };
    const exportUrl = computed(() => `/api/accounting/export.csv?from=${p.from}&to=${p.to}`);
    return { p, tab, data, journal, ledgerCode, accounts, load, setTab, preset, balTotals, openLedger, od, newOd, odBalance, saveOd, exportUrl, money, date, TYPE_LABEL };
  },
  template: `
  <div>
    <div class="page-head">
      <div><h1>Comptabilité</h1><div class="sub">Les écritures sont générées automatiquement à chaque facture, achat et paiement.</div></div>
      <div class="btns"><button class="btn" @click="newOd">+ Écriture manuelle (OD)</button><a class="btn" :href="exportUrl">⬇ Export pour la fiduciaire (CSV)</a></div>
    </div>
    <div class="toolbar">
      <input type="date" v-model="p.from" @change="load"> → <input type="date" v-model="p.to" @change="load">
      <button class="btn sm" @click="preset('month')">Ce mois</button><button class="btn sm" @click="preset('lastmonth')">Mois dernier</button>
      <button class="btn sm" @click="preset('quarter')">Trimestre</button><button class="btn sm" @click="preset('year')">Année</button><button class="btn sm" @click="preset('lastyear')">Année précédente</button>
    </div>
    <div class="tabs">
      <button v-for="[k, l] in [['moves','Journal'],['balance','Balance'],['ledger','Grand livre'],['vat','TVA'],['pnl','Résultat'],['aged','Créances clients']]" :class="{active: tab===k}" @click="setTab(k)">{{ l }}</button>
    </div>

    <div class="card" v-if="data !== null">
      <template v-if="tab==='moves'">
        <div class="toolbar"><select v-model="journal" @change="load"><option value="">Tous les journaux</option><option value="VTE">Ventes</option><option value="ACH">Achats</option><option value="BNK">Banque</option><option value="CAI">Caisse</option><option value="OD">Opérations diverses</option></select></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Date</th><th>Jnl</th><th>Pièce</th><th>Compte</th><th>Libellé</th><th class="num">Débit</th><th class="num">Crédit</th></tr></thead>
          <tbody><template v-for="m in data"><tr v-for="(l, i) in m.lines" :style="i === m.lines.length - 1 ? 'border-bottom: 2px solid #cbd5e1' : ''">
            <td>{{ i ? '' : date(m.date) }}</td><td>{{ i ? '' : m.journal_code }}</td><td>{{ i ? '' : m.ref }}</td>
            <td><button class="link" @click="openLedger(l.account_code)">{{ l.account_code }}</button> <span class="muted small">{{ l.account_name }}</span></td>
            <td class="small">{{ l.label }}</td><td class="num">{{ l.debit ? money(l.debit) : '' }}</td><td class="num">{{ l.credit ? money(l.credit) : '' }}</td>
          </tr></template></tbody>
        </table></div>
        <Empty v-if="!data.length" icon="📚" text="Aucune écriture sur la période"/>
      </template>

      <template v-if="tab==='balance'">
        <div class="table-wrap"><table>
          <thead><tr><th>Compte</th><th>Intitulé</th><th>Type</th><th class="num">Débit</th><th class="num">Crédit</th><th class="num">Solde</th></tr></thead>
          <tbody><tr v-for="r in data" class="click" @click="openLedger(r.code)"><td><b>{{ r.code }}</b></td><td>{{ r.name }}</td><td class="muted small">{{ TYPE_LABEL[r.type] }}</td>
            <td class="num">{{ money(r.debit) }}</td><td class="num">{{ money(r.credit) }}</td><td class="num strong">{{ money(r.balance) }}</td></tr></tbody>
          <tfoot v-if="balTotals"><tr><td colspan="3">Total</td><td class="num">{{ money(balTotals.d) }}</td><td class="num">{{ money(balTotals.c) }}</td><td class="num">{{ money(balTotals.d - balTotals.c) }}</td></tr></tfoot>
        </table></div>
      </template>

      <template v-if="tab==='ledger'">
        <div class="toolbar"><select v-model="ledgerCode" @change="load"><option v-for="a in accounts" :value="a.code">{{ a.code }} — {{ a.name }}</option></select><span class="muted">Solde d'ouverture : {{ money(data.opening) }}</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Date</th><th>Jnl</th><th>Pièce</th><th>Libellé</th><th class="num">Débit</th><th class="num">Crédit</th><th class="num">Solde</th></tr></thead>
          <tbody><tr v-for="l in data.lines"><td>{{ date(l.date) }}</td><td>{{ l.journal_code }}</td><td>{{ l.ref }}</td><td class="small">{{ l.label || l.move_label }}</td>
            <td class="num">{{ l.debit ? money(l.debit) : '' }}</td><td class="num">{{ l.credit ? money(l.credit) : '' }}</td><td class="num strong">{{ money(l.balance) }}</td></tr></tbody>
        </table></div>
        <Empty v-if="!data.lines.length" text="Aucun mouvement"/>
      </template>

      <template v-if="tab==='vat'">
        <div class="grid g3" style="margin-bottom:16px">
          <div class="kpi"><div class="l">TVA collectée (en aval)</div><div class="v">{{ money(data.totalCollected) }}</div></div>
          <div class="kpi"><div class="l">TVA déductible (en amont)</div><div class="v">{{ money(data.totalDeductible) }}</div></div>
          <div class="kpi" :class="{alert: data.due > 0}"><div class="l">{{ data.due >= 0 ? 'TVA à payer à l\\'AED' : 'Crédit de TVA' }}</div><div class="v">{{ money(Math.abs(data.due)) }}</div></div>
        </div>
        <div class="grid g2">
          <div><h3>Opérations imposables (ventes)</h3><table><thead><tr><th>Taux</th><th class="num">Base HT</th><th class="num">TVA</th></tr></thead>
            <tbody><tr v-for="r in data.collected"><td>{{ r.rate }} %</td><td class="num">{{ money(r.base) }}</td><td class="num">{{ money(r.tax) }}</td></tr></tbody></table></div>
          <div><h3>TVA en amont (achats)</h3><table><thead><tr><th>Taux</th><th class="num">Base HT</th><th class="num">TVA</th></tr></thead>
            <tbody><tr v-for="r in data.deductible"><td>{{ r.rate }} %</td><td class="num">{{ money(r.base) }}</td><td class="num">{{ money(r.tax) }}</td></tr></tbody></table></div>
        </div>
        <p class="muted small" style="margin-top:12px">Ces montants préparent votre déclaration de TVA (eCDF). Faites-les valider par votre fiduciaire avant dépôt.</p>
      </template>

      <template v-if="tab==='pnl'">
        <div class="grid g3" style="margin-bottom:16px">
          <div class="kpi"><div class="l">Produits</div><div class="v pos">{{ money(data.totalIncome) }}</div></div>
          <div class="kpi"><div class="l">Charges</div><div class="v neg">{{ money(data.totalExpense) }}</div></div>
          <div class="kpi"><div class="l">Résultat</div><div class="v" :class="data.result >= 0 ? 'pos' : 'neg'">{{ money(data.result) }}</div></div>
        </div>
        <div class="grid g2">
          <table><thead><tr><th>Produits</th><th class="num">Montant</th></tr></thead><tbody><tr v-for="r in data.income"><td>{{ r.code }} {{ r.name }}</td><td class="num">{{ money(r.amount) }}</td></tr></tbody></table>
          <table><thead><tr><th>Charges</th><th class="num">Montant</th></tr></thead><tbody><tr v-for="r in data.expense"><td>{{ r.code }} {{ r.name }}</td><td class="num">{{ money(r.amount) }}</td></tr></tbody></table>
        </div>
      </template>

      <template v-if="tab==='aged'">
        <div class="table-wrap"><table>
          <thead><tr><th>Facture</th><th>Client</th><th>Date</th><th>Échéance</th><th class="num">Retard</th><th class="num">Reste dû</th><th></th></tr></thead>
          <tbody><tr v-for="r in data"><td><a :href="'#/document/' + r.id"><b>{{ r.number }}</b></a></td><td>{{ r.customer_name }}<div class="muted small">{{ r.phone }} {{ r.email }}</div></td><td>{{ date(r.date) }}</td><td>{{ date(r.due_date) }}</td>
            <td class="num" :class="{late: r.days_late > 0}">{{ r.days_late > 0 ? r.days_late + ' j' : '' }}</td><td class="num strong">{{ money(r.residual) }}</td>
            <td><a class="btn sm" :href="'#/office?agent=secretariat&ask=' + encodeURIComponent('Rédige une relance de paiement ' + (r.days_late > 30 ? 'ferme' : 'courtoise') + ' pour la facture ' + r.number + ' de ' + r.customer_name + ' (reste dû ' + money(r.residual) + ', ' + r.days_late + ' jours de retard).')">✉️ Relance IA</a></td></tr></tbody>
          <tfoot><tr><td colspan="5">Total</td><td class="num">{{ money(data.reduce((s, r) => s + r.residual, 0)) }}</td><td></td></tr></tfoot>
        </table></div>
      </template>
    </div>

    <Modal v-if="od" title="Écriture manuelle (opérations diverses)" @close="od = null" wide>
      <div class="form-grid"><label>Date<input type="date" v-model="od.date"></label><label class="full" style="grid-column: span 2">Libellé<input v-model="od.label"></label></div>
      <table class="lines"><thead><tr><th>Compte</th><th>Libellé</th><th class="num">Débit</th><th class="num">Crédit</th><th></th></tr></thead>
        <tbody><tr v-for="(l, i) in od.lines"><td><select v-model="l.account_code"><option v-for="a in accounts" :value="a.code">{{ a.code }} {{ a.name }}</option></select></td><td><input v-model="l.label"></td>
          <td><input type="number" step="0.01" v-model.number="l.debit" class="right"></td><td><input type="number" step="0.01" v-model.number="l.credit" class="right"></td><td><button class="icon-btn" @click="od.lines.splice(i, 1)">✕</button></td></tr></tbody></table>
      <div class="btns"><button class="btn sm" @click="od.lines.push({account_code: '', debit: 0, credit: 0})">+ Ligne</button><span :class="odBalance ? 'neg' : 'pos'">Écart : {{ money(odBalance) }}</span></div>
      <template #foot><button class="btn primary" :disabled="odBalance !== 0 || !od.label" @click="saveOd">Enregistrer</button></template>
    </Modal>
  </div>`,
};
