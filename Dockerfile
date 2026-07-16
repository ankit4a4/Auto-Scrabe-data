FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm install

# Install Chromium + all required system dependencies for Playwright.
# This runs inside the Docker build, which has full permissions - unlike
# Render's native Node build environment, which was skipping this step
# even with a postinstall script.
RUN npx playwright install --with-deps chromium

COPY . .

ENV PORT=4000
EXPOSE 4000

CMD ["node", "server.js"]
