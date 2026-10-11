ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine

FROM ${NODE_IMAGE}

WORKDIR /app
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY --chown=node:node src ./src
COPY --chown=node:node bin ./bin
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node catalog-baseline ./catalog-baseline

RUN mkdir -p /srv/catalog-files && chown node:node /srv/catalog-files

ENV NODE_ENV=production
EXPOSE 3100

USER node
CMD ["node", "src/index.mjs"]
