# NEXUS AttendIQ — single service: API + built web app on one origin.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
ARG VITE_SHOW_DEMO=false
ENV VITE_SHOW_DEMO=$VITE_SHOW_DEMO
RUN npm run build -w apps/api && cd apps/web && npx vite build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev -w apps/api && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/drizzle apps/api/drizzle
COPY --from=build /app/apps/web/dist apps/web/dist
ENV STATIC_DIR=/app/apps/web/dist
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/start.js"]
