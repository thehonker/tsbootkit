# ── Build stage ──────────────────────────────────────────────────────
FROM docker.io/node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsup.config.ts ./
COPY src/ src/

RUN npm run build

# ── Runtime stage ───────────────────────────────────────────────────
FROM docker.io/node:24-alpine

# tini for proper PID 1 signal handling in containers
RUN apk add --no-cache tini

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist/ dist/

# Install example config for reference / CI testing
COPY config.example.yaml /etc/tsbootkit.example.yaml

# Default config path (mount your config here)
ENV TSBOOTKIT_CONFIG=/etc/tsbootkit.yaml

# TFTP root (mount your boot files here)
VOLUME /tftpboot

# DHCP server port (needs NET_ADMIN capability or --net=host)
EXPOSE 67/udp 69/udp 9470/tcp

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9470/health').then(r => { process.exit(r.ok ? 0 : 1) }).catch(() => process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/cli/pxed.mjs", "--config", "/etc/tsbootkit.yaml"]
