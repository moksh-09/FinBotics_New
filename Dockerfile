FROM python:3.11-slim

# System packages required for OpenCV, Paddle, and math libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy full application codebase
COPY . .

# Default environment configuration
ENV PORT=8010
ENV PYTHONUNBUFFERED=1

EXPOSE 8010

# Launch FastAPI web server
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8010}"]
