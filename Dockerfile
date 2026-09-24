# Build context: cliqhub-core repo root.
#
# @getcliqio/cliq-store is installed from GitHub Packages. Railway must
# expose GITHUB_TOKEN as a build-time variable (read:packages).

# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build

ARG GITHUB_TOKEN=""
ENV GITHUB_TOKEN=$GITHUB_TOKEN

WORKDIR /app
COPY .npmrc package.json package-lock.json ./
RUN npm ci --foreground-scripts && rm -f .npmrc
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data/packages \
    && test -f node_modules/@getcliqio/cliq-store/dist/index.js \
    && test -d node_modules/sequelize

EXPOSE 4000
CMD ["node", "dist/server.js"]
