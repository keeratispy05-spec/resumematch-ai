FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    tesseract-ocr \
    tesseract-ocr-tha \
    tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN pip3 install --break-system-packages --no-cache-dir -r server/requirements.txt

ENV NODE_ENV=production
ENV PYTHON_EXECUTABLE=python3
ENV DATA_DIR=/app/data

EXPOSE 10000

CMD ["npm", "run", "server"]
