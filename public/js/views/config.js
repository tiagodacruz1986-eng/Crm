// Paramètres → Configuration : les options utiles d'Odoo, rangées par application.
import { ref } from 'vue';
import { POST, DEL, act, toast, store } from '../api.js';

const DAYS = [[1, 'Lun'], [2, 'Mar'], [3, 'Mer'], [4, 'Jeu'], [5, 'Ven'], [6, 'Sam'], [0, 'Dim']];

export const ConfigPanel = {
  props: { s: Object },
  setup(props) {
    const O = props.s.options;
    const A = props.s.attendance;
    const bgInput = ref(null);
    const toggleDay = (d) => { A.work_days = A.work_days.includes(d) ? A.work_days.filter((x) => x !== d) : [...A.work_days, d]; };
    const addLevel = () => O.relances.levels.push({ days: (O.relances.levels.at(-1)?.days || 0) + 15, name: 'Nouvelle relance', action: 'email' });
    const uploadBg = async (file) => {
      if (!file) return;
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast('Choisissez une image PNG, JPEG ou WebP', 'error');
      const res = await fetch('/api/settings/home-bg', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const d = await res.json();
      if (!res.ok) return toast(d.error || 'Envoi impossible', 'error');
      props.s.home = d; store.settings.home = d;
      toast('Fond d\'écran enregistré');
    };
    const removeBg = async () => { const d = await act(() => DEL('/settings/home-bg'), 'Fond d\'écran retiré'); props.s.home = d; store.settings.home = d; };
    const runFollowups = async () => {
      const r = await act(() => POST('/automation/followups'));
      toast(r.done.length ? `${r.done.length} relance(s) : ${r.done.map((d) => d.number + ' (' + d.name + ')').join(', ')}` : 'Aucune facture à relancer aujourd\'hui');
    };
    const runReminders = async () => { const r = await act(() => POST('/automation/reminders')); toast(`${r.sent} rappel(s) envoyé(s) pour demain`); };
    return { O, A, DAYS, toggleDay, addLevel, bgInput, uploadBg, removeBg, runFollowups, runReminders, s: props.s };
  },
  template: `
  <div class="config">
    <section class="card cfg">
      <h2><Icon name="layout-grid"/> Général</h2>
      <div class="cfg-row"><div><b>Page d'accueil</b><small>Ce qui s'ouvre après la connexion</small></div>
        <select v-model="O.general.start_page"><option value="apps">Menu des applications (comme Odoo)</option><option value="dashboard">Tableau de bord</option></select></div>
      <div class="cfg-row"><div><b>Fond d'écran du menu</b><small>Une photo de votre garage, votre enseigne… (PNG, JPEG, WebP, 8 Mo max.)</small></div>
        <div class="btns"><div class="bg-thumb" :style="s.home?.background_version ? { backgroundImage: 'url(/home-bg?v=' + s.home.background_version + ')' } : {}"></div>
          <button class="btn sm" @click="bgInput.click()"><Icon name="image"/> {{ s.home?.background_version ? 'Changer' : 'Choisir une image' }}</button>
          <button v-if="s.home?.background_version" class="btn sm danger" @click="removeBg">Retirer</button>
          <input ref="bgInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="uploadBg($event.target.files[0]); $event.target.value = ''"></div></div>
    </section>

    <section class="card cfg">
      <h2><Icon name="chart-column"/> Ventes</h2>
      <div class="cfg-row"><div><b>Validité des devis</b><small>Imprimée sur les devis</small></div><div class="inline"><input type="number" min="1" v-model.number="O.ventes.quote_validity_days"> jours</div></div>
      <div class="cfg-row"><div><b>Remises sur les lignes</b><small>Colonne « remise % » dans les devis, OR et factures</small></div><label class="switch"><input type="checkbox" v-model="O.ventes.line_discounts"><i></i></label></div>
    </section>

    <section class="card cfg wide">
      <h2><Icon name="alarm-clock"/> Relances de paiement <small class="muted">(suivi des paiements d'Odoo)</small></h2>
      <div class="cfg-row"><div><b>Relances automatiques</b><small>Chaque jour, les factures en retard passent au niveau suivant</small></div><label class="switch"><input type="checkbox" v-model="O.relances.enabled"><i></i></label></div>
      <template v-if="O.relances.enabled">
        <div class="cfg-row"><div><b>Envoyer les e-mails sans validation</b><small>Sinon, une activité « à relancer » est créée pour vous</small></div><label class="switch"><input type="checkbox" v-model="O.relances.auto_send"><i></i></label></div>
        <div class="cfg-row"><div><b>Heure de passage</b></div><input type="time" v-model="O.relances.run_time" style="max-width:140px"></div>
      </template>
      <table class="levels">
        <thead><tr><th>Niveau</th><th>Après l'échéance</th><th>Action</th><th></th></tr></thead>
        <tbody><tr v-for="(l, i) in O.relances.levels" :key="i">
          <td><input v-model="l.name"></td><td class="inline"><input type="number" min="0" v-model.number="l.days" style="max-width:80px"> jours</td>
          <td><select v-model="l.action"><option value="email">E-mail de relance</option><option value="activity">Activité (appel, courrier recommandé…)</option></select></td>
          <td><button class="icon-btn" @click="O.relances.levels.splice(i, 1)"><Icon name="x"/></button></td></tr></tbody>
      </table>
      <div class="btns"><button class="btn sm" v-if="O.relances.levels.length < 6" @click="addLevel">+ Niveau</button><button class="btn sm" @click="runFollowups">▶ Lancer les relances maintenant</button></div>
    </section>

    <section class="card cfg">
      <h2><Icon name="calendar-days"/> Rendez-vous</h2>
      <div class="cfg-row"><div><b>Rappel au client la veille</b><small>E-mail de rappel automatique pour les rendez-vous du lendemain</small></div><label class="switch"><input type="checkbox" v-model="O.rendez_vous.reminder"><i></i></label></div>
      <div class="cfg-row" v-if="O.rendez_vous.reminder"><div><b>Heure d'envoi</b></div><input type="time" v-model="O.rendez_vous.reminder_time" style="max-width:140px"></div>
      <div class="cfg-row"><div><b>Durée par défaut</b></div><div class="inline"><input type="number" min="15" step="15" v-model.number="O.rendez_vous.default_duration"> minutes</div></div>
      <div class="btns" v-if="O.rendez_vous.reminder"><button class="btn sm" @click="runReminders">▶ Envoyer les rappels de demain maintenant</button></div>
    </section>

    <section class="card cfg">
      <h2><Icon name="user-check"/> Présences</h2>
      <div class="cfg-row"><div><b>Heures prévues par jour</b></div><div class="inline"><input type="number" min="0" max="24" step="0.5" v-model.number="A.hours_per_day"> heures</div></div>
      <div class="cfg-row"><div><b>Jours travaillés</b></div><div class="seg"><button v-for="[d, l] in DAYS" :key="d" :class="{ on: A.work_days.includes(d) }" @click="toggleDay(d)">{{ l }}</button></div></div>
      <div class="cfg-row"><div><b>Tolérance de retard</b><small>Après l'heure d'ouverture de l'atelier ({{ s.workshop.opening }})</small></div><div class="inline"><input type="number" min="0" v-model.number="A.tolerance_min"> minutes</div></div>
      <div class="cfg-row"><div><b>Départ automatique</b><small>Un pointage oublié est fermé après les heures prévues</small></div><label class="switch"><input type="checkbox" v-model="A.auto_checkout"><i></i></label></div>
      <div class="cfg-row"><div><b>Code PIN au kiosque</b><small>Obligatoire pour les comptes du bureau dans tous les cas</small></div><label class="switch"><input type="checkbox" v-model="A.kiosk_pin"><i></i></label></div>
      <div class="cfg-row"><div><b>Badges</b><small>Pointer en scannant sa carte / son badge au kiosque</small></div><label class="switch"><input type="checkbox" v-model="A.kiosk_badge"><i></i></label></div>
      <div class="cfg-row"><div><b>OR au kiosque pour le bureau</b><small>Les mécaniciens voient toujours leurs ordres de réparation</small></div><label class="switch"><input type="checkbox" v-model="A.kiosk_show_orders"><i></i></label></div>
    </section>

    <section class="card cfg">
      <h2><Icon name="book-open"/> Comptabilité</h2>
      <div class="cfg-row"><div><b>Date de verrouillage</b><small>Plus aucune écriture possible à cette date ou avant (période déclarée ou clôturée)</small></div><input type="date" v-model="O.comptabilite.lock_date" style="max-width:170px"></div>
      <div class="cfg-row"><div><b>Périodicité de la TVA</b></div><select v-model="O.comptabilite.vat_period" style="max-width:200px"><option value="month">Mensuelle</option><option value="quarter">Trimestrielle</option><option value="year">Annuelle</option></select></div>
    </section>

    <section class="card cfg">
      <h2><Icon name="package"/> Inventaire & achats</h2>
      <div class="cfg-row"><div><b>Autoriser le stock négatif</b><small>Désactivé : impossible de valider une facture si la pièce n'est pas en stock</small></div><label class="switch"><input type="checkbox" v-model="O.inventaire.allow_negative"><i></i></label></div>
      <div class="cfg-row"><div><b>Approbation des commandes</b><small>Au-delà d'un montant, seul un administrateur des achats peut commander</small></div><label class="switch"><input type="checkbox" v-model="O.achats.approval"><i></i></label></div>
      <div class="cfg-row" v-if="O.achats.approval"><div><b>Montant minimum</b></div><div class="inline"><input type="number" min="0" v-model.number="O.achats.approval_amount"> € TTC</div></div>
    </section>
  </div>`,
};
