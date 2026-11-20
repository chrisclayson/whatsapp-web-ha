# The Supervisor supplies BUILD_FROM pointing at a Home Assistant base image,
# which has no Node.js. Build from the official Node image directly so the
# add-on builds reliably on HAOS (including Home Assistant Green).
FROM node:24-alpine

RUN apk add --no-cache jq

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY run.sh /run.sh
RUN chmod +x /run.sh

ENV BRIDGE_DATA_DIR=/data \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=3000 \
    NODE_ENV=production

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1

CMD ["/run.sh"]
