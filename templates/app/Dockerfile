# Next.js (output: "standalone") + Drizzle app image.
# Template: LocalInfra/templates/app/Dockerfile — see LocalInfra/DEPLOYING-APPS.md.
# Needs: next.config with output: "standalone", scripts/migrate.mjs, lib/db/migrations, an
# /api/health route, and package-lock.json committed.

# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files, then strip the version field so version bumps don't bust the npm ci cache
COPY package.json package-lock.json ./
RUN sed -i '3s/"version": "[^"]*"/"version": "0.0.0"/' package.json package-lock.json

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source files (overwrites package.json with the real version)
COPY . .

# Ensure public/ exists so the runner stage's COPY doesn't fail when the app has none
RUN mkdir -p public

# Build args for NEXT_PUBLIC_ vars (must be available at build time)
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

# Build the application (output: "standalone" is set in next.config.ts)
RUN npm run build

# Production stage
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Only if the app runs pg_dump itself (e.g. an in-app backup): match LocalInfra's PG_VERSION,
# an older pg_dump refuses a newer server.
# ARG PG_MAJOR=17
# RUN apk add --no-cache postgresql${PG_MAJOR}-client

# Don't run as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Production deps at the lockfile's exact versions, for the plain-.mjs scripts (migrations, seeds)
# that run outside the Next.js server, and for native files Next's standalone tracing misses
# (sharp's dlopen'd libvips .so). Must come from the lockfile:
# a bare `npm install <pkg>` re-resolves every dependency to its latest version, and a newer
# libvips next to the standalone output's locked sharp fails with "libvips-cpp.so.X: No such file".
COPY --from=builder --chown=nextjs:nodejs /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy only the necessary files for standalone mode
COPY --from=builder /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Database migrations and the plain-.mjs scripts the entrypoint runs (no tsx/drizzle-kit needed)
COPY --from=builder --chown=nextjs:nodejs /app/lib/db/migrations ./lib/db/migrations
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts

# Copy and set up entrypoint script
COPY --chown=nextjs:nodejs docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Set entrypoint and command
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
