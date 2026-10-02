FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/dist ./dist
COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh && addgroup -S bot && adduser -S bot -G bot
USER bot

ENTRYPOINT ["./entrypoint.sh"]
