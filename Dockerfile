# Imagen de editor-ia-backend: el MISMO build sirve al API y al servicio de IA (gRPC); cambia el comando.
#   API:           node dist/servidor.js      (CMD por defecto; HTTP + WebSocket en HOST:PORT)
#   Servicio IA:   node dist/ia/principal.js  (comando de arranque del servicio de IA; gRPC en IA_HOST:IA_PORT)
# Siempre "node …" directo como PID 1, nunca "npm start": npm no reenvía SIGTERM y se perdería el apagado
# ordenado (/ready en 503, cierre de WebSockets, worker de BullMQ y conexiones).
# Ninguna variable ni secreto va en la imagen: los pone la plataforma (Railway). Las migraciones tampoco
# corren aquí: son de editor-ia-database.

# Node 24 (el del CI y de "engines") sobre Debian 12. Se puede cambiar con --build-arg (misma Debian).
ARG NODE_IMAGE=node:24-bookworm-slim

# ── Build: dependencias completas, cliente de Prisma, tipos del contrato gRPC y TypeScript ────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Sin NODE_ENV=production aquí: npm ci omitiría las devDependencies (tsc, prisma, buf).
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY scripts/prisma.mjs scripts/proto-tipos.mjs ./scripts/
COPY proto ./proto
RUN npm run -s prisma:generate && npm run -s proto:generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run -s build \
 # Quita las devDependencies: lo generado ya quedó compilado en dist/.
 && npm prune --omit=dev --no-audit --no-fund

# ── Runtime: solo lo necesario para correr, sin root ─────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# En un contenedor el API escucha en todas las interfaces; PORT lo pone la plataforma. El servicio de IA
# NO se abre por defecto: su IA_HOST se fija en su propio servicio (:: en la red privada de Railway).
ENV HOST=0.0.0.0
WORKDIR /app
USER node
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
# El contrato gRPC se carga en tiempo de ejecución desde proto/ (src/ia/contrato.ts: dos niveles arriba de dist/ia).
COPY --chown=node:node proto ./proto
EXPOSE 4200 4210
CMD ["node", "dist/servidor.js"]
