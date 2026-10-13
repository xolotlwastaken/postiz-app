#!/bin/sh
set -eu
node -e "const u=new URL(process.env.DATABASE_URL); if(u.searchParams.get('schema')!=='postiz'||process.env.POSTIZ_HEADLESS_ENABLED!=='true'||!process.env.REDIS_URL||!process.env.POSTIZ_HANDOFF_SECRET) throw Error('Headless publishing configuration is incomplete')"
# Checked-in migrations only; never run upstream's db push --accept-data-loss.
pnpm exec prisma migrate deploy --schema libraries/nestjs-libraries/src/database/prisma/schema.prisma
exec pm2-runtime start /app/var/docker/swaycue-processes.config.js
