# Stage 1: Build backend
FROM node:22-slim AS backend-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
RUN npm run build

# Stage 2: Build UI
FROM node:22-slim AS ui-build
WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ .
RUN npm run build

# Stage 3: Runtime
FROM node:22-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-pip && \
    pip3 install --break-system-packages yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=backend-build /app/dist/ dist/
COPY --from=ui-build /app/ui/dist/ ui/dist/
ENV NODE_ENV=production
ENV UI_DIR=./ui/dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
