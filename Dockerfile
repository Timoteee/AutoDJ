FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /music /app/cache
EXPOSE 3000
ENV PORT=3000 NODE_ENV=production
CMD ["node", "server.js"]
