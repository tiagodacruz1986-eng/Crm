# Garage Manager — image pour un serveur (VPS, NAS, cloud). Données dans le volume /app/data.
FROM node:22-alpine
# Le fuseau horaire est géré par Node (ICU complet), pas besoin du paquet tzdata
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data TZ=Europe/Luxembourg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3000/app-info.json >/dev/null || exit 1
CMD ["node", "server.js"]
