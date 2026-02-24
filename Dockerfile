# Stage 1: Install production dependencies
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Stage 2: Production image
FROM node:22-bookworm-slim
WORKDIR /app

# Install Python 3 + pymupdf for PDF text extraction, postgresql-client for bootstrap
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip postgresql-client && \
    pip3 install --no-cache-dir --break-system-packages pymupdf && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 grover && useradd -u 1001 -g grover -m grover

# Copy production dependencies from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY package.json ./
COPY grover.js ./
COPY graph-viz.html ./
COPY src/ ./src/
COPY config/ ./config/

# Create mount-point directories (owned by grover user)
RUN mkdir -p /app/corpus /app/index /app/config && \
    chown -R grover:grover /app

USER grover

# ONNX WASM needs extra heap
ENV NODE_OPTIONS="--max-old-space-size=4096 --experimental-wasm-modules"

EXPOSE 3000

# 60s start period: ONNX model downloads on first boot
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "const http=require('http');const r=http.get('http://localhost:3000/health',s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "grover.js"]
CMD ["serve"]
