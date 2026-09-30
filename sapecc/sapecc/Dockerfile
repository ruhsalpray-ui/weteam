FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_FILE=/app/data/sapecc.db
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
