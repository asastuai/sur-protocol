FROM node:20-alpine AS builder
WORKDIR /app
COPY keeper/package*.json ./
RUN npm ci
COPY keeper/tsconfig.json ./
COPY keeper/src/ ./src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY keeper/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
