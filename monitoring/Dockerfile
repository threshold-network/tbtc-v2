FROM node:22-alpine as builder

# Add packages necessary to perform the build process.
RUN apk add --update --no-cache \
    git \
    bash \
    build-base \
    python3 \
    && \
    rm -rf /var/cache/apk/ && mkdir /var/cache/apk/ && \
    rm -rf /usr/share/man

# Install node-prune (https://github.com/tj/node-prune)
RUN wget https://gobinaries.com/tj/node-prune
RUN sh node-prune

# Use `https://` instead of unauthenticated `git://` protocol.
RUN git config --global url."https://".insteadOf git://

WORKDIR /monitoring-build/typescript

COPY typescript/package.json typescript/yarn.lock typescript/.yarnrc.yml ./
RUN corepack enable && corepack yarn install --immutable
COPY typescript/src ./src
COPY typescript/scripts/rewrite-typechain-ethers-imports.js ./scripts/rewrite-typechain-ethers-imports.js
COPY typescript/tsconfig*.json typescript/typings.d.ts ./
RUN npm run build

WORKDIR /monitoring-build/monitoring

COPY monitoring/package.json monitoring/yarn.lock ./
COPY monitoring/tsconfig.json ./
COPY monitoring/src ./src

RUN npx --yes yarn@1.22.22 install --frozen-lockfile
RUN npx --yes yarn@1.22.22 build

# Prune development dependencies.
RUN rm -rf ./node_modules
RUN rm -rf ./external
RUN npx --yes yarn@1.22.22 install --production --frozen-lockfile

# Prune other unnecessary files from dependencies using node-prune.
RUN node-prune

FROM node:22-alpine as runner

WORKDIR /app/monitoring

COPY --from=builder /monitoring-build/monitoring/package.json ./package.json
COPY --from=builder /monitoring-build/monitoring/dist ./dist
COPY --from=builder /monitoring-build/monitoring/node_modules ./node_modules
COPY --from=builder /monitoring-build/typescript/package.json /app/typescript/package.json
COPY --from=builder /monitoring-build/typescript/dist /app/typescript/dist
RUN ln -sfn /app/typescript node_modules/@keep-network/tbtc-v2.ts && \
    ln -s monitoring/node_modules /app/node_modules

ENTRYPOINT ["node", "."]