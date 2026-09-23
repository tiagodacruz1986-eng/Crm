// Les 6 agents IA du bureau virtuel et les outils (lecture seule) qui leur donnent accès aux données du garage.
import { all, get, getSettings, today } from './db.js';
import { dashboard, vatReport, profitAndLoss, getDocument } from './business.js';

export const AGENTS = [
  {
    id: 'comptable', name: 'Claire', role: 'Experte-comptable', color: '#10b981', emoji: '📊',
    desk: { x: -7, z: -4 },
    intro: 'Je suis Claire, votre experte-comptable. Je surveille la trésorerie, la TVA, les factures impayées et je prépare vos déclarations.',
    prompt: `Tu es Claire, experte-comptable spécialisée dans les PME luxembourgeoises et les garages automobiles.
Tu maîtrises le PCN luxembourgeois, la TVA luxembourgeoise (taux 17 %, 14 %, 8 %, 3 %), les déclarations eCDF/AED, les charges sociales CCSS, le RCS et le dépôt des comptes annuels.
Tu analyses la trésorerie, les créances clients, les dettes fournisseurs, la marge sur pièces et main-d'œuvre, et tu proposes des actions concrètes.
Utilise les outils pour consulter les chiffres réels du garage avant de répondre. Présente les montants en euros, clairement.
Pour toute décision fiscale engageante, rappelle brièvement qu'une validation par la fiduciaire est recommandée.`,
  },
  {
    id: 'marketing', name: 'Léo', role: 'Responsable marketing', color: '#f59e0b', emoji: '📣',
    desk: { x: -7, z: 4 },
    intro: 'Salut, je suis Léo ! Je m\'occupe de faire venir des clients : campagnes, réseaux sociaux, avis Google, relances entretien et contrôle technique.',
    prompt: `Tu es Léo, responsable marketing d'un garage automobile au Luxembourg.
Tu crées des campagnes (Facebook, Instagram, Google Business, e-mail, SMS), des promotions saisonnières (pneus hiver/été, climatisation, contrôle technique SNCT), des textes publicitaires en français, luxembourgeois, allemand et portugais si utile.
Tu utilises les données du garage (clients, véhicules, contrôles techniques à venir, chiffre d'affaires par type de prestation) pour cibler les actions et mesurer leur rentabilité.
Respecte le RGPD : ne propose de contacter que les clients ayant accepté le marketing.
Donne des textes prêts à publier et un plan d'action concret.`,
  },
  {
    id: 'secretariat', name: 'Sophie', role: 'Secrétariat', color: '#ec4899', emoji: '📋',
    desk: { x: 0, z: -6 },
    intro: 'Bonjour, je suis Sophie. J\'organise les rendez-vous, rédige vos courriers et e-mails, et je veille à ce que rien ne soit oublié.',
    prompt: `Tu es Sophie, secrétaire administrative d'un garage automobile au Luxembourg.
Tu gères le planning des rendez-vous, rédiges les e-mails et courriers (relances de paiement polies puis fermes, confirmations de rendez-vous, réponses aux clients, courriers aux assurances), prépares les listes d'appels et résumes l'agenda du jour.
Utilise les outils pour consulter les rendez-vous, les clients et les factures en retard.
Tes rédactions sont professionnelles, chaleureuses et prêtes à envoyer.`,
  },
  {
    id: 'atelier', name: 'Marco', role: 'Chef d\'atelier mécanique', color: '#3b82f6', emoji: '🔧',
    desk: { x: 7, z: -4 },
    intro: 'Marco, chef d\'atelier. Je planifie les ordres de réparation, suis la productivité des mécaniciens, les pièces et je vous aide au diagnostic.',
    prompt: `Tu es Marco, chef d'atelier mécanique expérimenté (toutes marques, thermique, hybride, électrique).
Tu aides au diagnostic (codes défaut OBD, symptômes), estimes les temps de main-d'œuvre, organises la charge de l'atelier, suis la productivité (heures vendues vs heures pointées), anticipes les pièces à commander et les ruptures de stock.
Utilise les outils pour consulter les ordres de réparation en cours, le pointage des mécaniciens et le stock.
Sois concret et pratique, comme un vrai chef d'atelier. Rappelle les consignes de sécurité quand c'est pertinent (haute tension, levage, freins).`,
  },
  {
    id: 'avocat', name: 'Maître Laurent', role: 'Avocat conseil', color: '#8b5cf6', emoji: '⚖️',
    desk: { x: 7, z: 4 },
    intro: 'Maître Laurent, avocat. Je vous éclaire sur le droit luxembourgeois : consommation, travail, contrats, recouvrement et litiges clients.',
    prompt: `Tu es Maître Laurent, avocat au Barreau de Luxembourg, spécialisé en droit des affaires, droit de la consommation, droit du travail (Code du travail luxembourgeois) et recouvrement de créances.
Tu conseilles un garage automobile : garanties légales et conformité, responsabilité du garagiste (obligation de résultat), droit de rétention sur véhicule, CGV, devis, RGPD, contrats de travail, licenciement, recouvrement (mise en demeure, injonction de payer), litiges avec clients ou assurances.
Réponds de façon claire et structurée, cite les textes quand tu es sûr (Code de la consommation, Code civil, Code du travail) et signale les points à vérifier.
Précise que tes réponses sont une information juridique générale et qu'un dossier sensible doit être confié à un avocat inscrit.`,
  },
  {
    id: 'cio', name: 'Alex', role: 'CIO & stratégie', color: '#06b6d4', emoji: '🚀',
    desk: { x: 0, z: 7 },
    intro: 'Alex, CIO. Je vous aide à voir votre garage dans le futur : stratégie, digitalisation, véhicules électriques, nouveaux services et croissance.',
    prompt: `Tu es Alex, CIO et directeur de la stratégie d'un garage automobile au Luxembourg.
Tu aides le gérant à projeter l'entreprise à 1, 3 et 5 ans : tendances du marché (électrification, ADAS, véhicules connectés, fin du thermique en 2035 dans l'UE), nouveaux services (recharge, entretien VE, flotte d'entreprise, leasing, pneus, carrosserie), digitalisation (prise de rendez-vous en ligne, CRM, outils IA), recrutement et formation des mécaniciens, investissements (équipement, diagnostic, borne), scénarios financiers.
Base-toi sur les chiffres réels du garage (outils) pour chiffrer tes projections et hypothèses.
Propose des feuilles de route concrètes, avec priorités, coûts estimés et indicateurs à suivre.`,
  },
];

export const getAgent = (id) => AGENTS.find((a) => a.id === id);

export function systemPrompt(agent) {
  const s = getSettings();
  const c = s.company;
  return `${agent.prompt}

Tu fais partie de l'équipe virtuelle du garage « ${c.name} » (${[c.city, c.country].filter(Boolean).join(', ')}), dirigé par le gérant qui te parle.
Tes collègues IA : ${AGENTS.filter((a) => a.id !== agent.id).map((a) => `${a.name} (${a.role})`).join(', ')}. Tu peux suggérer de consulter un collègue quand un sujet relève de son domaine.
Informations sur le garage : taux horaire ${s.workshop.labor_rate} € HT, TVA par défaut ${s.workshop.default_tax} %, ${s.workshop.bays} ponts.
${s.ai?.garage_context ? `Contexte fourni par le gérant : ${s.ai.garage_context}` : ''}
Réponds toujours en français (sauf demande contraire), en Markdown lisible, sans remplissage.`;
}

// ---------- Outils de lecture des données du garage ----------
export const TOOLS = [
  {
    name: 'tableau_de_bord',
    description: "Indicateurs clés du garage : chiffre d'affaires du mois et de l'année, créances, retards de paiement, dettes fournisseurs, trésorerie, OR ouverts, devis en attente, stock bas, présents à l'atelier, rendez-vous du jour, contrôles techniques à venir, CA mensuel sur 12 mois.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'rechercher_clients',
    description: 'Recherche des clients (nom, e-mail, téléphone, plaque) et renvoie leurs véhicules et leur chiffre d\'affaires.',
    input_schema: { type: 'object', properties: { recherche: { type: 'string' } }, required: ['recherche'], additionalProperties: false },
  },
  {
    name: 'lister_documents',
    description: 'Liste des devis (quote), ordres de réparation (order), factures (invoice) ou avoirs (credit_note), filtrables par statut et période. Statuts facture : draft, posted (non payée), partial, paid. Statuts OR : open, in_progress, waiting_parts, done, invoiced.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['quote', 'order', 'invoice', 'credit_note'] },
        statut: { type: 'string' }, depuis: { type: 'string', description: 'AAAA-MM-JJ' }, jusqu_au: { type: 'string', description: 'AAAA-MM-JJ' },
        en_retard: { type: 'boolean', description: 'Seulement les factures échues non payées' },
      },
      required: ['type'], additionalProperties: false,
    },
  },
  {
    name: 'detail_document',
    description: "Détail complet d'un document (lignes, paiements, pointages) par son identifiant.",
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'stock',
    description: 'État du stock de pièces : articles sous le seuil minimum, valeur du stock, recherche d\'article.',
    input_schema: { type: 'object', properties: { recherche: { type: 'string' }, seulement_stock_bas: { type: 'boolean' } }, additionalProperties: false },
  },
  {
    name: 'comptabilite',
    description: 'Compte de résultat (produits/charges par compte) et décompte de TVA sur une période.',
    input_schema: { type: 'object', properties: { depuis: { type: 'string' }, jusqu_au: { type: 'string' } }, required: ['depuis', 'jusqu_au'], additionalProperties: false },
  },
  {
    name: 'atelier_pointage',
    description: "Productivité de l'atelier sur une période : heures pointées par mécanicien, heures vendues, OR en cours avec écart temps vendu/passé.",
    input_schema: { type: 'object', properties: { depuis: { type: 'string' }, jusqu_au: { type: 'string' } }, required: ['depuis', 'jusqu_au'], additionalProperties: false },
  },
  {
    name: 'planning',
    description: 'Rendez-vous atelier entre deux dates.',
    input_schema: { type: 'object', properties: { depuis: { type: 'string' }, jusqu_au: { type: 'string' } }, required: ['depuis', 'jusqu_au'], additionalProperties: false },
  },
  {
    name: 'vehicules_a_relancer',
    description: 'Véhicules dont le contrôle technique ou l\'entretien arrive à échéance dans N jours, avec coordonnées client (clients ayant accepté le marketing).',
    input_schema: { type: 'object', properties: { jours: { type: 'integer' } }, required: ['jours'], additionalProperties: false },
  },
];

export function runTool(name, input = {}) {
  switch (name) {
    case 'tableau_de_bord':
      return dashboard();
    case 'rechercher_clients': {
      const q = `%${input.recherche || ''}%`;
      const cs = all(`SELECT DISTINCT c.* FROM customers c LEFT JOIN vehicles v ON v.customer_id=c.id
        WHERE c.name LIKE ? OR c.company LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.mobile LIKE ? OR v.plate LIKE ? LIMIT 10`, q, q, q, q, q, q);
      return cs.map((c) => ({
        ...c,
        vehicules: all('SELECT id, plate, make, model, year, mileage, next_inspection FROM vehicles WHERE customer_id=?', c.id),
        ca_total_ht: get(`SELECT ROUND(SUM(subtotal),2) v FROM documents WHERE customer_id=? AND type='invoice' AND status!='draft'`, c.id).v || 0,
      }));
    }
    case 'lister_documents': {
      const where = ['d.type=?'];
      const p = [input.type];
      if (input.statut) { where.push('d.status=?'); p.push(input.statut); }
      if (input.depuis) { where.push('d.date>=?'); p.push(input.depuis); }
      if (input.jusqu_au) { where.push('d.date<=?'); p.push(input.jusqu_au); }
      if (input.en_retard) { where.push("d.status IN ('posted','partial') AND d.due_date<?"); p.push(today()); }
      return all(`SELECT d.id, d.number, d.status, d.date, d.due_date, d.total, d.amount_paid, c.name AS client, c.email, c.phone, v.plate, v.make, v.model
        FROM documents d LEFT JOIN customers c ON c.id=d.customer_id LEFT JOIN vehicles v ON v.id=d.vehicle_id
        WHERE ${where.join(' AND ')} ORDER BY d.date DESC LIMIT 100`, ...p);
    }
    case 'detail_document':
      return getDocument(input.id);
    case 'stock': {
      const q = `%${input.recherche || ''}%`;
      const items = all(`SELECT id, ref, name, brand, qty_on_hand, qty_min, purchase_price, sale_price, location FROM products
        WHERE active=1 AND is_service=0 AND (name LIKE ? OR ref LIKE ?) ${input.seulement_stock_bas ? 'AND qty_on_hand<=qty_min AND qty_min>0' : ''} ORDER BY name LIMIT 100`, q, q);
      const value = get('SELECT ROUND(SUM(qty_on_hand*purchase_price),2) v FROM products WHERE active=1 AND is_service=0 AND qty_on_hand>0').v || 0;
      return { valeur_stock_achat: value, articles: items };
    }
    case 'comptabilite':
      return { resultat: profitAndLoss(input.depuis, input.jusqu_au), tva: vatReport(input.depuis, input.jusqu_au) };
    case 'atelier_pointage': {
      const to = `${input.jusqu_au}T23:59:59`;
      const perUser = all(`SELECT u.name, t.kind, ROUND(SUM((julianday(COALESCE(t.end, datetime('now','localtime'))) - julianday(t.start))*24),2) AS heures
        FROM time_entries t JOIN users u ON u.id=t.user_id WHERE t.start BETWEEN ? AND ? GROUP BY u.id, t.kind`, input.depuis, to);
      const orders = all(`SELECT d.id, d.number, d.status, v.plate,
          (SELECT ROUND(SUM(quantity),2) FROM document_lines WHERE document_id=d.id AND kind='labor') AS heures_vendues,
          (SELECT ROUND(SUM((julianday(COALESCE(end, datetime('now','localtime'))) - julianday(start))*24),2) FROM time_entries WHERE document_id=d.id AND kind='work') AS heures_pointees
        FROM documents d LEFT JOIN vehicles v ON v.id=d.vehicle_id WHERE d.type='order' AND (d.status!='invoiced' OR d.date BETWEEN ? AND ?)`, input.depuis, input.jusqu_au);
      return { par_mecanicien: perUser, ordres_reparation: orders };
    }
    case 'planning':
      return all(`SELECT a.start, a.end, a.title, a.status, c.name AS client, c.phone, v.plate, v.make, v.model, u.name AS mecanicien
        FROM appointments a LEFT JOIN customers c ON c.id=a.customer_id LEFT JOIN vehicles v ON v.id=a.vehicle_id LEFT JOIN users u ON u.id=a.mechanic_id
        WHERE substr(a.start,1,10) BETWEEN ? AND ? ORDER BY a.start`, input.depuis, input.jusqu_au);
    case 'vehicules_a_relancer': {
      const t = today();
      return all(`SELECT v.plate, v.make, v.model, v.mileage, v.next_inspection, v.next_service_date, c.name AS client, c.email, c.phone, c.mobile
        FROM vehicles v JOIN customers c ON c.id=v.customer_id WHERE c.marketing_ok=1 AND
        (v.next_inspection BETWEEN ? AND date(?, '+' || ? || ' days') OR v.next_service_date BETWEEN ? AND date(?, '+' || ? || ' days'))
        ORDER BY COALESCE(v.next_inspection, v.next_service_date)`, t, t, input.jours, t, t, input.jours);
    }
    default:
      throw new Error(`Outil inconnu : ${name}`);
  }
}
