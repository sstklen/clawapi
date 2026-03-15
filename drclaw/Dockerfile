FROM oven/bun:1.3-alpine

WORKDIR /app

# 安裝依賴
COPY package.json bun.lockb* ./
RUN bun install --production --frozen-lockfile 2>/dev/null || bun install --production

# 複製源碼
COPY src/ src/
COPY tsconfig.json ./

# 建立資料目錄
RUN mkdir -p /app/data

EXPOSE 3200

CMD ["bun", "run", "src/server.ts"]
