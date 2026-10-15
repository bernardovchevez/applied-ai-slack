FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ARG APP_ENV=production
ENV NODE_ENV=production \
    APP_ENV=${APP_ENV} \
    PORT=3001

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 slackbot

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

USER slackbot
EXPOSE 3001

CMD ["node", "dist/src/index.js"]
