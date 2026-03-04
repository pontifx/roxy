FROM node:20-alpine

# Set working directory inside container
WORKDIR /app

# Copy package files first to leverage Docker layer caching.
# npm ci only re-runs when package-lock.json changes.
COPY package*.json ./

# Install only production dependencies — no devDependencies in the image.
# --production flag respects NODE_ENV=production automatically but we're
# explicit here for clarity.
RUN npm ci --production

# Copy application source after dependencies to maximize cache reuse.
COPY src ./src

# ext-authz HTTP check service port
EXPOSE 9191

# Run as non-root for security
USER node

CMD ["node", "src/server.js"]
