# Scalar Commons reference agent.
#
# Build context is the REPOSITORY ROOT (the agent depends on the workspace sdk/
# until the SDK is on npm, and the one npm lockfile lives at the root):
#   docker build -f agent/Dockerfile -t ghcr.io/tejaspatil1936/scalar-agent:0.1 .
#
# Run (the key comes from the env file, never from the command line):
#   docker run --env-file agent.env -v scalar-agent:/state ghcr.io/tejaspatil1936/scalar-agent:0.1
# agent.env: SCALAR_WS=..., AGENT_MNEMONIC=..., AGENT_MODE=provider|buyer|both

FROM node:22-slim AS build
WORKDIR /src
# The JS packages are one npm workspace with one package-lock.json. `npm ci`
# checks that lockfile against every workspace manifest, so all of them are
# copied (manifests only), not just the two this image builds.
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
COPY faucet/package.json faucet/
COPY indexer/package.json indexer/
COPY explorer/package.json explorer/
COPY agent/package.json agent/
COPY landing/package.json landing/
COPY docs/package.json docs/
COPY testkit/package.json testkit/
COPY examples/reference-agent/package.json examples/reference-agent/
COPY experiments/live/package.json experiments/live/
# sdk and agent plus the root devDependencies (typescript, @types/node).
RUN npm ci -w sdk -w agent --include-workspace-root
# Both packages' tsconfig.json extend the shared root base.
COPY tsconfig.base.json ./
COPY sdk sdk
COPY agent agent
RUN npm run build -w sdk && npm run build -w agent
# Reinstall production dependencies only. @polkadot/* is hoisted once into the
# root node_modules, and node_modules/@scalar-commons/sdk is a symlink to ../../sdk,
# so the SDK and the agent load the same single copy.
RUN npm ci --omit=dev -w agent

FROM node:22-slim
ENV NODE_ENV=production STATE_DIR=/state
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/sdk/package.json sdk/
COPY --from=build /src/sdk/dist sdk/dist
COPY --from=build /src/agent/package.json agent/
COPY --from=build /src/agent/dist agent/dist
RUN mkdir /state && chown node:node /state
USER node
VOLUME /state
WORKDIR /app/agent
CMD ["node", "dist/main.js"]
