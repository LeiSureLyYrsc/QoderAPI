FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

FROM node:24-alpine AS runtime

RUN addgroup -S qoder && adduser -S qoder -G qoder

WORKDIR /app

COPY --from=builder --chown=qoder:qoder /app/dist/ ./dist/
COPY --from=builder --chown=qoder:qoder /app/public/ ./public/
COPY --chown=qoder:qoder package.json ./

RUN mkdir -p /home/qoder/.qoder-reserve \
  && chown -R qoder:qoder /home/qoder/.qoder-reserve

USER qoder

ENV NODE_ENV=production \
    QODER_RESERVE_CONFIG_DIR=/home/qoder/.qoder-reserve \
    PORT=3927

EXPOSE 3927

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3927/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
