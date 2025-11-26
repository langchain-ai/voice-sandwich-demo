# syntax=docker/dockerfile:1

# Build stage
FROM node:20-slim AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate

# Install build dependencies for native modules (wrtc, onnxruntime-node)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/graphs/package.json ./packages/graphs/
COPY packages/web/package.json ./packages/web/
COPY packages/webrtc/package.json ./packages/webrtc/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build all packages
RUN pnpm run build

# Production stage
FROM node:20-slim AS runner

# Install runtime dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    # Required for WebRTC
    libglib2.0-0 \
    libsm6 \
    libxrender1 \
    libxext6 \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/graphs/package.json ./packages/graphs/
COPY packages/web/package.json ./packages/web/
COPY packages/webrtc/package.json ./packages/webrtc/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod=false

# Copy built files and source (needed for tsx runtime)
COPY --from=builder /app/packages ./packages

# Expose ports:
# - 3001: HTTP/WebSocket server (signaling + static files)
# - 10000-10100: UDP ports for WebRTC ICE traffic
EXPOSE 3001
EXPOSE 10000-10100/udp

# Set working directory to webrtc package
WORKDIR /app/packages/webrtc

# Start the WebRTC server
CMD ["pnpm", "run", "server"]
