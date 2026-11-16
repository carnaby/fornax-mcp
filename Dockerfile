# Fornax server: one image with the server, the worker bundle and the tray's installers it hands out at /downloads.
# Runs as a non-root user and works with any UID; writes only to DATA_DIR (/data) and /tmp.
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN npm install --global pnpm@10.33.2
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build && pnpm bundle:worker
# The server with production dependencies only; sharp brings its linux-x64 libvips here. The tray's MSI and deb go
# next to the worker bundle when the build context has them (CI's image job puts them in tray-installers/; spec 06d 2.2).
RUN pnpm --filter @fornax/server deploy --prod --legacy /out \
 && mkdir -p /out/downloads \
 && cp dist/worker/fornax-worker-*.zip /out/downloads/fornax-worker.zip \
 && for kind in msi deb; do \
      f="$(find tray-installers -name "*.$kind" -print -quit 2>/dev/null || true)"; \
      if [ -n "$f" ]; then cp "$f" "/out/downloads/fornax-tray.$kind"; fi; \
    done

FROM node:24-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 HOME=/tmp
WORKDIR /app
COPY --from=build /out /app
COPY docker/fornax-admin /usr/local/bin/fornax-admin
# Without a mounted volume the data directory must still be writable for whatever UID runs the image.
RUN chmod 0755 /usr/local/bin/fornax-admin && mkdir -p /data && chmod 1777 /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "/app/dist/src/healthcheck.js"]
# node is PID 1: SIGTERM reaches the server, which closes the HTTP server, webhooks and the database.
CMD ["node", "/app/dist/src/main.js"]
