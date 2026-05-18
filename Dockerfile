FROM node:20-alpine

WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev && npm install typescript tsx

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Remove dev source (keep dist and static)
RUN rm -rf src/dashboard/static/.gitkeep 2>/dev/null || true

# Create data directory
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/index.js"]
