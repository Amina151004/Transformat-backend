# Start from a small official Node.js image
FROM node:20-slim

# Install LibreOffice inside this container.
# --no-install-recommends keeps the image smaller.
RUN apt-get update && \
    apt-get install -y --no-install-recommends libreoffice && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first (better Docker layer caching:
# if only your code changes, npm install won't re-run).
COPY package.json ./
RUN npm install --omit=dev

# Now copy the rest of the app
COPY . .

# Make sure the folders the server writes to actually exist
RUN mkdir -p uploads converted

EXPOSE 3000

CMD ["node", "server.js"]