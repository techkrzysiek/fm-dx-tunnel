# --- Build stage: compile the panel stylesheet (Tailwind CSS) ---
FROM node:24-alpine AS build

WORKDIR /app

# Exact versions from the lockfile
COPY app/package.json app/package-lock.json ./
RUN npm ci

COPY app/ ./
RUN npm run build:css

# --- Runtime image ---
FROM node:24-alpine

WORKDIR /app

# Install runtime dependencies only (better layer caching)
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application files and the compiled stylesheet
COPY app/index.js ./
COPY app/public/ ./public/
COPY --from=build /app/public/app.css ./public/app.css

# Create config directory and set permissions
RUN mkdir -p /config && chown -R node:node /app /config

ENV NODE_ENV=production \
    CONFIG_PATH=/config/config.yaml

EXPOSE 7002

# Run as non-root user (node user is built into node:alpine image)
USER node

CMD ["node", "index.js"]
