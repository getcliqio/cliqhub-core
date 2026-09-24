# Build context is the repo root (Railway "Root Directory" = /).
#
# Pre-deploy:
#   (cd services/backend && npm run build)
#
# @getcliqio/cliq-store is installed from GitHub Packages (private,
# @getcliqio scope). The Railway service MUST expose GITHUB_TOKEN as
# a build-time variable (with read:packages on the getcliqio org).
#
# IMPORTANT: never interpolate GITHUB_TOKEN into the RUN command text —
# Railway/Docker build logs print the expanded RUN line and will leak
# the PAT. Keep the token in ENV so npm expands ${GITHUB_TOKEN} from
# .npmrc privately; multi-stage copy leaves it out of the runtime image.

# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS deps

ARG GITHUB_TOKEN=""
# Build-stage only — not copied into the final image.
ENV GITHUB_TOKEN=$GITHUB_TOKEN

WORKDIR /app

# `.npmrc` scopes @getcliqio → npm.pkg.github.com and reads
# ${GITHUB_TOKEN} from the environment (not from the shell command line).
COPY .npmrc ./
COPY services/backend/package.json services/backend/package-lock.json ./

RUN npm ci --omit=dev --foreground-scripts \
    && rm -f .npmrc

FROM node:22-alpine

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./
COPY services/backend/dist ./dist

RUN mkdir -p /app/data/packages \
    && test -f node_modules/@getcliqio/cliq-store/dist/index.js \
    && test -d node_modules/sequelize

EXPOSE 4000
CMD ["node", "dist/server.js"]
