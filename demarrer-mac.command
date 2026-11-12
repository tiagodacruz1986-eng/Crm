#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js n'est pas installé. Téléchargez-le sur https://nodejs.org (bouton LTS), puis relancez ce fichier."
  open https://nodejs.org
  read -p "Appuyez sur Entrée pour fermer…"
  exit 1
fi
[ -d node_modules ] || { echo "Première installation, patientez une minute…"; npm install; }
[ -f .env ] || cp .env.example .env
# Version de Node.js : 22.13 ou plus récente
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo "Votre version de Node.js est trop ancienne (il faut la 22.13 ou plus récente). Téléchargez la version LTS sur https://nodejs.org, puis relancez ce fichier."
  open https://nodejs.org
  read -p "Appuyez sur Entrée pour fermer…"
  exit 1
fi
# Port choisi dans le fichier .env (PORT=3001), sinon 3000
PORT_NUM=$(grep -E '^PORT=' .env 2>/dev/null | tail -n 1 | cut -d= -f2 | tr -d '[:space:]"')
PORT_NUM=${PORT_NUM:-3000}
echo "Garage Manager démarre. Ne fermez pas cette fenêtre. Adresse : http://localhost:$PORT_NUM"
# Le navigateur s'ouvre quand le logiciel répond (jusqu'à 30 secondes d'attente)
(for i in $(seq 1 30); do curl -s -o /dev/null "http://localhost:$PORT_NUM/app-info.json" && { open "http://localhost:$PORT_NUM"; break; }; sleep 1; done) &
npm start
echo
echo "Le logiciel s'est arrêté. Si un message d'erreur est affiché ci-dessus, notez-le avant de fermer."
read -p "Appuyez sur Entrée pour fermer…"
