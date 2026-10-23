FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY orca.source.json orca.yaml README.md LICENSE NOTICE ./
RUN mkdir -p /app/.data /app/workspace && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "src/server.mjs"]
