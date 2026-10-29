# syntax=docker/dockerfile:1

## ---------------------------------------------------------------------------
## deps / build
## Node 24 is the floor: lib/db.ts uses the built-in `node:sqlite`, which is
## only available from 22.5 and is what the app opens its database with.
## ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build


## ---------------------------------------------------------------------------
## runtime
##
## Two system packages this app actually shells out to:
##   ffmpeg - transcode, slicing the analysis video into SAM chunks, and the
##            frame / mask crops the classifier is shown
##   perl   - exiftool-vendored ships the exiftool Perl script but not an
##            interpreter; gps.ts calls it for the Insta360 GPS track
## ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      perl \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app
COPY --from=build /app ./

# data/ and storage/ are bind-mounted by compose, .env is mounted read-only so
# the key never lands in an image layer.
VOLUME ["/app/data", "/app/storage"]

EXPOSE 3100

CMD ["./node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3100"]
