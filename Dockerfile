# Image de production de l'API MédiRDV (publiée sur ghcr.io par la CI/CD)
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3001
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js seed.js ./
COPY lib ./lib
COPY public ./public
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/sante" || exit 1
CMD ["node", "server.js"]
