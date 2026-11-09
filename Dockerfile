FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY client/package*.json ./client/
RUN npm install --prefix client
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
COPY package*.json ./
RUN npm install --omit=dev
COPY backend ./backend
COPY scripts ./scripts
COPY database ./database
COPY --from=build /app/client/dist ./client/dist
EXPOSE 4000
CMD ["node","backend/node.js"]
