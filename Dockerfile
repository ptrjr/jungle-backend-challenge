FROM oven/bun:1.3.14
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
RUN bun run build
USER bun
CMD ["sh", "-c", "bun run migration:run && exec bun dist/main.js"]
