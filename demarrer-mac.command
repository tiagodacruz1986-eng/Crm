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
echo "Garage Manager démarre. Ne fermez pas cette fenêtre. Adresse : http://localhost:3000"
(sleep 3; open http://localhost:3000) &
npm start
