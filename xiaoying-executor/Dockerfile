ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine

FROM ${NODE_IMAGE}

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY bin ./bin
COPY public ./public
COPY src ./src
COPY IGOLIBRARY_LICENSE.txt THIRD_PARTY_NOTICES.md ./

RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 43120

CMD ["node", "bin/server.mjs"]
