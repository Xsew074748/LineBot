# ── Stage: Production image ───────────────────────────────
FROM node:20-alpine

# ติดตั้ง dependencies ระดับ OS ที่จำเป็น (tzdata สำหรับ timezone ไทย)
RUN apk add --no-cache tzdata
ENV TZ=Asia/Bangkok

WORKDIR /app

# Copy package files ก่อน (cache layer — rebuild เฉพาะเมื่อ package เปลี่ยน)
COPY package.json package-lock.json ./

# ติดตั้งเฉพาะ production dependencies (ไม่รวม jest, devDependencies)
RUN npm ci --omit=dev

# Copy โค้ดโปรเจค
COPY adapters/     ./adapters/
COPY middleware/   ./middleware/
COPY mock-server/  ./mock-server/
COPY public/       ./public/
COPY routes/       ./routes/
COPY services/     ./services/
COPY config.js     ./
COPY index.js      ./

# สร้าง data/ directory ไว้รับ volume mount (users.json, notified_alerts.json)
RUN mkdir -p data logs

# Bot รันบน port 3000 (ตรงกับ PORT ใน .env.example)
EXPOSE 3000

# Health check — LINE Webhook จะ GET /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "index.js"]
