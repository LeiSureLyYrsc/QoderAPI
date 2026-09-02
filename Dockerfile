FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

FROM node:24-alpine AS runtime

RUN apk add --no-cache su-exec shadow \
  && addgroup -S qoder \
  && adduser -S qoder -G qoder

WORKDIR /app

COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/public/ ./public/
COPY package.json ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh \
  && mkdir -p /home/qoder/.qoder-reserve \
  && chown -R qoder:qoder /home/qoder/.qoder-reserve /app

ENV NODE_ENV=production \
    QODER_RESERVE_CONFIG_DIR=/home/qoder/.qoder-reserve \
    HOST=0.0.0.0 \
    PORT=3927 \
    PUID=1000 \
    PGID=1000

EXPOSE 3927

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3927) + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["serve"]
