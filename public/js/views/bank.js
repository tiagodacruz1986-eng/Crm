import { ref, onMounted } from 'vue';
import { GET, POST, PUT, DEL, act, toast, money, date, datetime } from '../api.js';

export const Bank = {
  setup() {
    const accounts = ref([]);
    const lines = ref([]);
    const filter = ref('unmatched');
    const accountFilter = ref('');
    const edit = ref(null);
    const assign = ref(null);
    const chart = ref([]);
    const providers = ref({});
    const load = async () => {
      accounts.value = await GET('/bank-accounts');
      lines.value = await GET(`/bank/lines?${filter.value ? 'status=' + filter.value : ''}${accountFilter.value ? '&account=' + accountFilter.value : ''}`);
    };
    onMounted(async () => { chart.value = await GET('/accounting/accounts'); providers.value = await GET('/bank/providers'); load(); });
    const importFile = async (acc, e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      const r = await act(() => POST(`/bank/import/${acc.id}`, text));
      toast(`${r.added} opérations importées, ${r.skipped} doublons ignorés, ${r.matched} rapprochées automatiquement`);
      e.target.value = '';
      load();
    };
    const sync = async (acc) => { await act(() => POST(`/bank/sync/${acc.id}`)); load(); };
    const saveAccount = async () => {
      const a = edit.value;
      if (a.id) await act(() => PUT('/bank-accounts/' + a.id, a), 'Enregistré'); else await act(() => POST('/bank-accounts', a), 'Compte ajouté');
      edit.value = null; load();
    };
    const match = async (l, s) => { await act(() => POST(`/bank/lines/${l.id}/match`, { kind: s.kind, id: s.id }), `Rapproché avec ${s.number}`); load(); };
    const ignore = async (l) => { await act(() => POST(`/bank/lines/${l.id}/ignore`)); load(); };
    const doAssign = async () => { await act(() => POST(`/bank/lines/${assign.value.line.id}/assign`, { account_code: assign.value.account, label: assign.value.label }), 'Écriture passée'); assign.value = null; load(); };
    const auto = async () => { const r = await act(() => POST('/bank/auto-reconcile')); toast(`${r.matched} opérations rapprochées`); load(); };
    const QUICK = [['6181', 'Frais bancaires'], ['6211', 'Salaires'], ['6231', 'CCSS'], ['6111', 'Loyer'], ['6171', 'Carburant'], ['461418', 'TVA (AED)'], ['5161', 'Dépôt / retrait espèces']];
    return { accounts, lines, filter, accountFilter, load, importFile, sync, edit, saveAccount, match, ignore, assign, doAssign, auto, chart, providers, QUICK, money, date, datetime };
  },
  template: `
  <div>
    <div class="page-head">
      <div><h1>Banque</h1><div class="sub">Importez vos relevés (CAMT.053 ou CSV) : les paiements sont rapprochés automatiquement des factures.</div></div>
      <div class="btns"><button class="btn" @click="auto">⚡ Rapprochement auto</button><button class="btn primary" @click="edit = {account_code: '5131', provider: 'import', opening_balance: 0}">+ Compte bancaire</button></div>
    </div>
    <div class="grid g3">
      <div v-for="a in accounts" class="card">
        <div class="card-head"><div><h2 style="margin:0">🏦 {{ a.name }}</h2><div class="muted small">{{ a.bank_name }} {{ a.iban }}</div></div><button class="icon-btn" @click="edit = {...a}">✎</button></div>
        <div class="kpi" style="box-shadow:none;padding:0;border:0"><div class="l">Solde selon relevés</div><div class="v">{{ money(a.statement_balance) }}</div></div>
        <div class="muted small" style="margin:6px 0 10px">{{ a.unmatched }} à rapprocher · dernière synchro {{ a.last_sync ? datetime(a.last_sync) : 'jamais' }}</div>
        <div class="btns">
          <label class="btn sm" style="flex-direction:row;color:inherit">📥 Importer un relevé<input type="file" accept=".xml,.csv,.txt,.053" hidden @change="importFile(a, $event)"></label>
          <button class="btn sm" v-if="a.provider !== 'import'" @click="sync(a)">🔄 Synchroniser</button>
        </div>
      </div>
      <div class="card" v-if="!accounts.length"><Empty icon="🏦" text="Ajoutez votre compte bancaire (BCEE, BGL, BIL, POST, Raiffeisen…)"/></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="toolbar">
        <select v-model="filter" @change="load"><option value="unmatched">À rapprocher</option><option value="matched">Rapprochées</option><option value="ignored">Ignorées</option><option value="">Toutes</option></select>
        <select v-model="accountFilter" @change="load"><option value="">Tous les comptes</option><option v-for="a in accounts" :value="a.id">{{ a.name }}</option></select>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Contrepartie</th><th>Communication</th><th class="num">Montant</th><th>Rapprochement</th></tr></thead>
        <tbody><tr v-for="l in lines">
          <td class="nowrap">{{ date(l.date) }}</td>
          <td>{{ l.counterparty }}<div class="muted small">{{ l.counterparty_iban }}</div></td>
          <td class="small" style="max-width:320px">{{ l.communication }}</td>
          <td class="num strong" :class="l.amount > 0 ? 'pos' : 'neg'">{{ money(l.amount) }}</td>
          <td>
            <template v-if="l.status === 'unmatched'">
              <div class="btns">
                <button v-for="s in l.suggestions" class="btn sm" :class="{primary: s.score >= 90}" @click="match(l, s)" :title="'Confiance ' + s.score + '%'">
                  {{ s.kind === 'invoice' ? '🧾' : '🛒' }} {{ s.number }} · {{ s.partner }} · {{ money(s.residual) }}</button>
                <button class="btn sm" @click="assign = {line: l, account: l.amount < 0 ? '6181' : '7580', label: l.communication || l.counterparty}">📚 Affecter à un compte</button>
                <button class="btn sm" @click="ignore(l)">Ignorer</button>
              </div>
            </template>
            <Badge v-else :status="l.status"/>
          </td>
        </tr></tbody>
      </table></div>
      <Empty v-if="!lines.length" icon="✅" text="Rien à rapprocher"/>
    </div>

    <Modal v-if="edit" :title="edit.id ? 'Compte bancaire' : 'Nouveau compte bancaire'" @close="edit = null">
      <div class="form-grid">
        <label>Nom<input v-model="edit.name" placeholder="BCEE compte courant"></label><label>Banque<input v-model="edit.bank_name"></label>
        <label class="full">IBAN<input v-model="edit.iban"></label><label>BIC<input v-model="edit.bic"></label>
        <label>Compte comptable<select v-model="edit.account_code"><option v-for="a in chart.filter(c => c.code.startsWith('51'))" :value="a.code">{{ a.code }} {{ a.name }}</option></select></label>
        <label>Solde d'ouverture<input v-model.number="edit.opening_balance" type="number" step="0.01"></label>
        <label>Connexion<select v-model="edit.provider"><option v-for="(p, k) in providers" :value="k">{{ p.name }}</option></select></label>
      </div>
      <p class="muted small" v-if="edit.provider !== 'import'">La synchronisation directe (PSD2) nécessite un contrat avec l'agrégateur bancaire et ses identifiants API. En attendant, utilisez l'import de relevés CAMT.053 disponible dans votre banque en ligne.</p>
      <template #foot><button class="btn primary" :disabled="!edit.name" @click="saveAccount">Enregistrer</button></template>
    </Modal>
    <Modal v-if="assign" title="Affecter l'opération à un compte" @close="assign = null">
      <p><b>{{ money(assign.line.amount) }}</b> — {{ assign.line.counterparty }} <span class="muted">{{ assign.line.communication }}</span></p>
      <div class="btns"><button v-for="[c, n] in QUICK" class="btn sm" :class="{primary: assign.account === c}" @click="assign.account = c">{{ n }}</button></div>
      <label>Compte<select v-model="assign.account"><option v-for="a in chart" :value="a.code">{{ a.code }} — {{ a.name }}</option></select></label>
      <label>Libellé<input v-model="assign.label"></label>
      <template #foot><button class="btn primary" @click="doAssign">Passer l'écriture</button></template>
    </Modal>
  </div>`,
};
