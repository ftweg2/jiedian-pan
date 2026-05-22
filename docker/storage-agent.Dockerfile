FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/storage-agent/package.json apps/storage-agent/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/storage-driver/package.json packages/storage-driver/package.json
RUN npm install

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/storage-agent apps/storage-agent
RUN npm -w @wangpan/shared run build
RUN npm -w @wangpan/storage-agent run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/storage-agent ./apps/storage-agent
WORKDIR /app/apps/storage-agent
EXPOSE 4010
CMD ["node", "dist/index.js"]
