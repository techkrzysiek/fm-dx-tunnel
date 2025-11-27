FROM node:24-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY app/package.json ./
RUN npm install --production

# Copy application files
COPY app/ ./

# Create config directory and set permissions
RUN mkdir -p /config && chown -R node:node /app /config

ENV CONFIG_PATH=/config/config.yaml

EXPOSE 7002

# Run as non-root user (node user is built into node:alpine image)
USER node

CMD ["node", "index.js"]

