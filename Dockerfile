FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
EXPOSE 10000
# Render free web sets PORT=10000; our server.js falls back to 3001 if unset
ENV PORT=10000
CMD ["node", "src/server.js"]
