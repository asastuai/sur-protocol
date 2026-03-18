FROM node:20-alpine AS builder
WORKDIR /app
COPY oracle-keeper/package*.json ./
RUN npm ci
COPY oracle-keeper/tsconfig.json ./
COPY oracle-keeper/src/ ./src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY oracle-keeper/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
