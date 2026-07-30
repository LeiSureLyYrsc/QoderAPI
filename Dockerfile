FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
RUN pnpm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build

FROM node:24-alpine

RUN addgroup -S qoder && adduser -S qoder -G qoder

WORKDIR /app

COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY package.json ./
COPY public/ ./public/

RUN mkdir -p /home/qoder/.qoder-reserve && chown -R qoder:qoder /home/qoder/.qoder-reserve /app

USER qoder

ENV QODER_RESERVE_CONFIG_DIR=/home/qoder/.qoder-reserve
ENV PORT=3927

EXPOSE 3927

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]