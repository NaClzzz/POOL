ARG NODE_IMAGE=node:24.13.0-slim
FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@12.18.0

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS prod-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM dependencies AS web-build
COPY . .
# 唯一公开构建变量；生产默认空值，使浏览器连接同域 /socket.io/。
ARG NEXT_PUBLIC_SOCKET_URL=
ENV NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL
ENV NEXT_TELEMETRY_DISABLED=1
# 构建导入认证模块会校验配置；以下均为不可用占位值，真实配置只在运行时注入。
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    REDIS_URL=redis://127.0.0.1:6379 \
    BETTER_AUTH_SECRET=build-placeholder-not-a-production-secret \
    BETTER_AUTH_URL=http://localhost:3000 \
    pnpm build

FROM dependencies AS server-build
COPY scripts/build-server.mjs scripts/migrate.mjs ./scripts/
COPY socket-server ./socket-server
COPY src ./src
COPY tsconfig.json ./
RUN pnpm build:server

# 运行阶段不继承 pnpm、构建工具、开发源码或构建时环境变量。
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
USER node

FROM runtime AS web
ENV HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
COPY --from=web-build --chown=node:node /app/.next/standalone ./
COPY --from=web-build --chown=node:node /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]

FROM runtime AS socket
COPY --from=prod-dependencies --chown=node:node /app/package.json ./
COPY --from=prod-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=server-build --chown=node:node /app/dist/socket.mjs ./dist/socket.mjs
EXPOSE 3002
CMD ["node", "--conditions=react-server", "dist/socket.mjs"]

FROM runtime AS migrate
COPY --from=prod-dependencies --chown=node:node /app/package.json ./
COPY --from=prod-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=server-build --chown=node:node /app/dist/migrate.mjs ./dist/migrate.mjs
COPY --chown=node:node drizzle ./drizzle
CMD ["node", "dist/migrate.mjs"]
