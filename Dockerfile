FROM node:20-slim

RUN apt-get update && apt-get install -y \
    wget unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN wget -q https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz \
    && tar -xzf piper_linux_x86_64.tar.gz -C /usr/local/bin/ \
    && rm piper_linux_x86_64.tar.gz

RUN mkdir -p /usr/local/share/piper-voices && \
    wget -q -P /usr/local/share/piper-voices \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/rohan/medium/hi_IN-rohan-medium.onnx \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/rohan/medium/hi_IN-rohan-medium.onnx.json \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/te/te_IN/maya/medium/te_IN-maya-medium.onnx \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/te/te_IN/maya/medium/te_IN-maya-medium.onnx.json

RUN curl -L -o /usr/local/share/piper-voices/en_US-ryan-high.onnx \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx && \
    curl -L -o /usr/local/share/piper-voices/en_US-ryan-high.onnx.json \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json && \
    curl -L -o /usr/local/share/piper-voices/en_GB-alba-medium.onnx \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx && \
    curl -L -o /usr/local/share/piper-voices/en_GB-alba-medium.onnx.json \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx.json

RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install opencv-python-headless Pillow librosa numpy soundfile --break-system-packages

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

ENV PIPER_BIN_PATH=/usr/local/bin/piper
ENV PIPER_VOICES_DIR=/usr/local/share/piper-voices
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node", "dist/server.cjs"]
