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

WORKDIR /monitoring-build

# Copy only essential files.
COPY package.json yarn.lock ./
COPY tsconfig.json ./
COPY src ./src

RUN yarn install --frozen-lockfile --ignore-scripts

RUN yarn build

# Prune development dependencies.
RUN rm -rf ./node_modules
RUN rm -rf ./external
RUN yarn install --production --frozen-lockfile --ignore-scripts

# Prune other unnecessary files from dependencies using node-prune.
RUN node-prune

FROM node:22-alpine as runner

WORKDIR /monitoring

COPY --from=builder /monitoring-build/package.json ./package.json
COPY --from=builder /monitoring-build/dist ./dist
COPY --from=builder /monitoring-build/node_modules ./node_modules

ENTRYPOINT ["node", "."]