# Scalar Commons reference agent.
#
# Build context is the REPOSITORY ROOT (the agent depends on ../sdk until the
# SDK is on npm):
#   docker build -f agent/Dockerfile -t ghcr.io/tejaspatil1936/scalar-agent:0.1 .
#
# Run (the key comes from the env file, never from the command line):
#   docker run --env-file agent.env -v scalar-agent:/state ghcr.io/tejaspatil1936/scalar-agent:0.1
# agent.env: SCALAR_WS=..., AGENT_MNEMONIC=..., AGENT_MODE=provider|buyer|both

FROM node:22-slim AS build
WORKDIR /src
COPY sdk/package.json sdk/package-lock.json sdk/
RUN npm --prefix sdk ci
COPY sdk sdk
RUN npm --prefix sdk run build
COPY agent/package.json agent/package-lock.json agent/
RUN npm --prefix agent ci
COPY agent agent
RUN npm --prefix agent run build && npm --prefix agent prune --omit=dev
# Vendor the built SDK as a real directory instead of the file: symlink, so its
# @polkadot imports resolve to the agent's single copy (one @polkadot/util, no
# "multiple versions" warning).
RUN rm agent/node_modules/@scalar-commons/sdk \
 && mkdir -p agent/node_modules/@scalar-commons/sdk \
 && cp -r sdk/dist sdk/package.json agent/node_modules/@scalar-commons/sdk/

FROM node:22-slim
ENV NODE_ENV=production STATE_DIR=/state
WORKDIR /app
COPY --from=build /src/agent/package.json ./
COPY --from=build /src/agent/node_modules ./node_modules
COPY --from=build /src/agent/dist ./dist
RUN mkdir /state && chown node:node /state
USER node
VOLUME /state
CMD ["node", "dist/main.js"]
