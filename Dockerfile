ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine

FROM ${NODE_IMAGE} AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY vendor/image-size-disabled ./vendor/image-size-disabled
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS build

ENV WRANGLER_LOG_PATH=/tmp/wrangler.log
ARG NEXT_PUBLIC_XIAOYING_URL=""
ENV NEXT_PUBLIC_XIAOYING_URL=$NEXT_PUBLIC_XIAOYING_URL

COPY . .
RUN npx vinext build

FROM ${NODE_IMAGE} AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0

COPY package.json package-lock.json ./
COPY vendor/image-size-disabled ./vendor/image-size-disabled
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server.mjs ./

USER node
EXPOSE 3000

CMD ["node", "server.mjs"]
