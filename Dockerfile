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
RUN mkdir -p /app/data/jobs && chown -R node:node /app/data
ENV NODE_ENV=production
ENV UI_DIR=./ui/dist
ENV LOCAL_OUTPUT_DIR=/app/data/jobs
# A container must listen on its own interface to be reachable at all. Exposure
# is decided by the publish flag: use -p 127.0.0.1:3000:3000. Host and Origin
# checks still apply; set ALLOWED_HOSTS to reach it by any other name.
ENV HOST=0.0.0.0
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/index.js"]
