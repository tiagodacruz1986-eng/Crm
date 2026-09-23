# 🔧 Garage Manager — logiciel de gestion de garage + bureau virtuel IA

Logiciel complet de gestion de garage automobile (pensé pour le Luxembourg), inspiré d'Odoo et des meilleurs logiciels d'atelier, avec une équipe de **6 agents IA** dans un **bureau virtuel 3D**.

## ✨ Fonctionnalités

| Module | Ce qu'il fait |
|---|---|
| 🏠 **Tableau de bord** | CA du mois/année, impayés et retards, trésorerie, OR en cours, stock bas, mécaniciens présents, rendez-vous du jour, contrôles techniques à venir, graphique 12 mois |
| 🔧 **Atelier (Kanban)** | Ordres de réparation en colonnes (À faire → En cours → Attente pièces → Terminé), glisser-déposer, retards signalés, qui travaille dessus en direct |
| 📅 **Planning** | Agenda hebdomadaire par mécanicien, création en un clic, « Véhicule arrivé → OR » |
| ⏱️ **Pointage mécaniciens** | Kiosque tablette (`/kiosk.html`) avec code PIN : arrivée/départ, démarrer/arrêter sur une fiche de travail, cocher les travaux faits, diagnostic, km, notes. Heures vendues vs heures pointées, productivité |
| 📝 **Devis → OR → Facture → Avoir** | Main-d'œuvre, pièces du stock, forfaits, remises, TVA 17/14/8/3 %, impression PDF avec **QR code de paiement SEPA**, signature « bon pour accord » |
| 👥 **Clients & véhicules** | Fiche client, historique complet par véhicule, **décodage VIN**, contrôle technique / entretien, consentement RGPD |
| 📦 **Stock** | Articles, emplacements, seuils mini, marges, inventaire, mouvements, **réapprovisionnement automatique** par fournisseur |
| 🛒 **Achats** | Commandes fournisseurs, réception (entrée en stock), factures fournisseurs et frais généraux, paiements |
| 🏦 **Banque** | Import des relevés **CAMT.053** (toutes les banques luxembourgeoises) ou CSV, dédoublonnage, **rapprochement automatique** avec les factures clients et fournisseurs, affectation en 1 clic (frais, salaires, loyer, TVA…) |
| 📚 **Comptabilité** | Écritures automatiques (ventes, achats, banque, caisse), journal, balance, grand livre, **décompte TVA**, compte de résultat, créances clients, OD manuelles, export CSV pour la fiduciaire |
| 🤖 **Bureau IA 3D** | 6 agents qui lisent vos vraies données : Claire (experte-comptable), Léo (marketing), Sophie (secrétariat), Marco (chef d'atelier), Maître Laurent (avocat), Alex (CIO & stratégie). Discussion, **tâches programmées** (une fois, chaque jour, lun-ven, chaque semaine, chaque mois), rapports, **réunion d'équipe** avec synthèse du CIO |
| 🔍 **Recherche globale** | `Ctrl + K` : plaque, client, n° de facture, référence pièce |

## 🚀 Installation

### Le plus simple (sans taper de commande)

1. Installez **Node.js** (version LTS) depuis https://nodejs.org
2. Sur GitHub, bouton vert **Code → Download ZIP**, puis décompressez le dossier
3. Double-cliquez sur **`demarrer-windows.bat`** (Windows) ou **`demarrer-mac.command`** (Mac)
4. Le navigateur s'ouvre sur http://localhost:3000 — laissez la fenêtre noire ouverte tant que vous utilisez le logiciel

### En ligne de commande

Prérequis : **Node.js 22 ou plus récent** (https://nodejs.org).

```bash
npm install
cp .env.example .env      # puis mettez votre clé API Claude dans .env
npm start
```

Ouvrez **http://localhost:3000** : au premier lancement, créez le compte du gérant.

- Tablette atelier : **http://localhost:3000/kiosk.html** (ou `http://IP-DU-PC:3000/kiosk.html` depuis le réseau du garage)
- Pour découvrir avec des données d'exemple (sur une base vide) : `npm run demo` → connexion `demo@garage.lu` / `demo1234`, PIN mécaniciens `1111`, `2222`, `3333`

Les données sont enregistrées dans `data/garage.db` (SQLite). **Sauvegardez ce fichier régulièrement.**

## 🤖 Activer les agents IA

1. Créez une clé sur https://console.anthropic.com
2. Mettez-la dans `.env` : `ANTHROPIC_API_KEY=sk-ant-...`
3. Redémarrez (`npm start`)

Les agents utilisent le modèle Claude `claude-opus-5` (modifiable via `CLAUDE_MODEL`), peuvent consulter les données du garage (lecture seule) et faire des recherches sur le web. Les tâches programmées tournent tant que le logiciel est allumé (fuseau `Europe/Luxembourg`).
Dans **Paramètres → Agents IA**, décrivez votre garage : ce contexte est partagé avec toute l'équipe.

## 🔄 Importer depuis Odoo

**Paramètres → Import Odoo** : indiquez l'adresse de votre Odoo, le nom de la base, votre e-mail de connexion et une **clé API** (Odoo → votre profil → Sécurité du compte → Nouvelle clé API), puis **Tester la connexion** et **Lancer l'import**.

Sont importés : clients et fournisseurs (avec TVA, adresse), véhicules (plaque, VIN, marque/modèle, kilométrage, 1ère immatriculation, **prochain contrôle technique**, prochain entretien, dimension pneus, propriétaire) et articles (référence, EAN, prix d'achat/vente, TVA, catégorie, fournisseur principal, **quantité en stock**).
L'import peut être relancé : les fiches déjà importées sont mises à jour, jamais dupliquées. Les données restent sur votre ordinateur.

## 🏦 Banque

- **Aujourd'hui** : dans votre banque en ligne (Spuerkeess, BGL BNP Paribas, BIL, POST, Raiffeisen, ING…), téléchargez le relevé au format **CAMT.053 (XML)** et importez-le dans *Banque*. Les virements contenant le numéro de facture sont rapprochés automatiquement ; les autres vous sont proposés.
- **Synchronisation automatique** : nécessite un agrégateur bancaire agréé PSD2 (ex. Ponto / Isabel Group) et un contrat avec lui. Le connecteur est prévu dans `src/bank.js` (`syncAccount`) et s'active dès que vous disposez des identifiants API.

## ⚖️ Important

- Le plan comptable fourni est **inspiré du PCN luxembourgeois** et le décompte TVA est une aide : faites valider le paramétrage et vos déclarations par votre fiduciaire.
- Les réponses de l'avocat et de l'experte-comptable IA sont de l'information générale, pas un avis professionnel engageant.
- Une facture validée ne peut plus être modifiée ni supprimée (obligation légale) : utilisez une note de crédit.

## 🧱 Technique

- Serveur : Node.js + Express, base SQLite intégrée (`node:sqlite`), aucune installation de base de données
- Interface : Vue 3 + Three.js servis en local (fonctionne sans internet, sauf l'IA et le décodage VIN en ligne)
- IA : SDK officiel Anthropic (`@anthropic-ai/sdk`), outils de lecture des données + recherche web
- Tests : `npm test` (parcours complet achat → stock → devis → OR → pointage → facture → banque → comptabilité, et import Odoo)

```
server.js            API + serveur web
src/db.js            schéma, paramètres, numérotation, plan comptable
src/business.js      documents, stock, achats, écritures comptables, rapports
src/bank.js          import CAMT.053/CSV, rapprochement
src/agents.js        les 6 agents + outils d'accès aux données
src/claude.js        appels à l'API Claude, réunion d'équipe
src/scheduler.js     tâches programmées
src/odoo.js          import depuis Odoo (JSON-RPC)
public/              interface (Vue) + kiosque + bureau 3D
```
