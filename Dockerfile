FROM node:22-alpine AS build

WORKDIR /app
ENV WRANGLER_LOG_PATH=/tmp/wrangler.log

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .
RUN npx vinext build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "npx vinext start"]
