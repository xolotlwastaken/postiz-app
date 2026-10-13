ARG POSTIZ_BASE_IMAGE=ghcr.io/gitroomhq/postiz-app@sha256:785f97312f66a347fb96cdccc4ded5a33ced69a672c89a9adc8054e7d6a21dc5
FROM ${POSTIZ_BASE_IMAGE}
WORKDIR /app
RUN npm install --prefix /opt/swaycue-dependencies --ignore-scripts --no-audit --no-fund file-type@22.0.2 \
    && mkdir -p /app/node_modules/music-metadata/node_modules \
    && mv /app/node_modules/file-type /app/node_modules/music-metadata/node_modules/file-type \
    && ln -s /opt/swaycue-dependencies/node_modules/file-type /app/node_modules/file-type
COPY apps/backend /app/apps/backend
COPY apps/orchestrator /app/apps/orchestrator
COPY libraries /app/libraries
# Match the headless namespace's Keyword registration in both API and workflow
# bundles. Standalone Postiz keeps its existing Text attribute definitions.
COPY libraries/nestjs-libraries/src/temporal/temporal.search.attribute.headless.ts /app/libraries/nestjs-libraries/src/temporal/temporal.search.attribute.ts
COPY tsconfig.base.json tsconfig.json /app/
COPY var/docker/swaycue-entrypoint.sh var/docker/swaycue-processes.config.js /app/var/docker/
COPY var/docker/nginx.conf /etc/nginx/nginx.conf
RUN pnpm exec prisma generate --schema=libraries/nestjs-libraries/src/database/prisma/schema.prisma \
    && NODE_OPTIONS=--max-old-space-size=6144 pnpm --filter postiz-backend run build \
    && NODE_OPTIONS=--max-old-space-size=6144 pnpm --filter postiz-orchestrator run build \
    && rm -rf /app/apps/frontend \
    && chmod +x /app/var/docker/swaycue-entrypoint.sh
# Retain upload serving, but remove the frontend proxy altogether.
RUN node -e "const fs=require('fs'); const p='/etc/nginx/nginx.conf'; const c=fs.readFileSync(p,'utf8'); fs.writeFileSync(p,c.replace(/        location \/ \{[\s\S]*?\n        \}/, '        location / { return 404; }'));"
ENV POSTIZ_HEADLESS_ENABLED=true DISABLE_REGISTRATION=true
ENTRYPOINT ["/app/var/docker/swaycue-entrypoint.sh"]
CMD []

COPY supabase-ca.crt /app/supabase-ca.crt
ENV NODE_EXTRA_CA_CERTS=/app/supabase-ca.crt
