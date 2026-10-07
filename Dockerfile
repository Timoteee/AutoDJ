FROM node:22-alpine
RUN apk add --no-cache ffmpeg python3 py3-pip \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]==2026.8.19"
ENV PATH="/opt/yt-dlp/bin:${PATH}"
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /music /app/cache
EXPOSE 3000
ENV PORT=3000 NODE_ENV=production
CMD ["node", "server.js"]
