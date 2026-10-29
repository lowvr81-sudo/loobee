FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js ./server.js
ENV NODE_ENV=production
EXPOSE 8787
CMD ["npm", "start"]
