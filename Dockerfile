FROM node:20-slim

# Install LibreOffice + Python (for the pdf2docx sidecar script)
RUN apt-get update && \
    apt-get install -y --no-install-recommends libreoffice python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Set up a Python venv and install pdf2docx into it
RUN python3 -m venv /opt/pdf2docx-venv && \
    /opt/pdf2docx-venv/bin/pip install --no-cache-dir pdf2docx

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p uploads converted

EXPOSE 3000

CMD ["node", "server.js"]