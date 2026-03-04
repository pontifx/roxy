FROM node:20-alpine

# Install build dependencies for better-sqlite3 (native addon).
# These are needed at build time to compile the native module,
# but we keep them in the same layer to minimize final image size.
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./

# Install all production dependencies including native addons.
# better-sqlite3 requires native compilation — hence the build deps above.
RUN npm ci --production

# Remove build tools after compilation to shrink the image.
# The compiled .node binary is already in node_modules.
RUN apk del python3 make g++

# Copy application source
COPY src ./src

# Data directory for SQLite database (mounted as a Docker volume)
RUN mkdir -p /app/data && chown node:node /app/data

EXPOSE 3000

# Run as non-root
USER node

CMD ["node", "src/index.js"]
