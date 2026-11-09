FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

FROM node:20-alpine AS app
WORKDIR /app
COPY server/package*.json ./server/
WORKDIR /app/server
RUN apk add --no-cache python3 make g++ && npm install --omit=dev
WORKDIR /app
COPY server/ ./server/
COPY --from=client-build /app/client/dist ./client/dist
ENV NODE_ENV=production
ENV PORT=4000
ENV DB_FILE=/data/workdesk.sqlite
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 4000
CMD ["node","server/index.js"]
