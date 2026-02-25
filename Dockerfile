FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js ./
COPY dj.html ./
COPY display.html ./
COPY dj.js ./
COPY engine.js ./

RUN mkdir -p /music

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -q --spider http://localhost:3000/ || exit 1

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]
