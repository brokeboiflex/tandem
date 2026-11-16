# Tandem gateway image. The per-person runtime image is built from ./runtime.
# Multi-arch index digest (linux/amd64 and linux/arm64).
FROM oven/bun:1.3.9-slim@sha256:8ca06c7812d9050ccc4b80799685f395d6a0d051d3b7207dfd120e2b437b1ec9
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY public ./public
USER bun
EXPOSE 8787 8790
CMD ["bun", "src/gateway.ts"]
