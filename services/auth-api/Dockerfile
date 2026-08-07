FROM docker.m.daocloud.io/library/node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY --chown=node:node src ./src
COPY --chown=node:node bin ./bin
COPY --chown=node:node scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3100

USER node
CMD ["node", "src/index.mjs"]
