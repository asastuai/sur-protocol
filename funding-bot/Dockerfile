FROM node:20-alpine AS builder
WORKDIR /app
COPY funding-bot/package*.json ./
RUN npm ci
COPY funding-bot/tsconfig.json ./
COPY funding-bot/src/ ./src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY funding-bot/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
