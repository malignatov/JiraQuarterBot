# JiraQuarterBot Deployment Guide

This guide outlines how to deploy the JiraQuarterBot in a production or staging environment using Docker Compose. The stack is containerized for easy deployment and includes an auto-configuring `ngrok` sidecar to handle inbound webhooks from RingCentral.

---

## 🏗 Architecture Overview

The deployment consists of two Docker containers:
1. **`bot`**: The Node.js application running the RingCentral bot and Jira client.
2. **`ngrok`**: A sidecar container that creates a secure HTTPS tunnel to the bot's local port (3000). 

A custom `docker-entrypoint.sh` runs before the bot starts. It waits for the `ngrok` tunnel to initialize, queries ngrok's local API (`http://ngrok:4040/api/tunnels`) to discover the public URL, and dynamically injects `RINGCENTRAL_OAUTH_REDIRECT_URI` and `WEBHOOKS_DELIVERY_ADDRESS` into the bot's environment.

**Storage**: All persistent data (like RingCentral access tokens and webhook subscription IDs) is saved inside a Docker named volume (`bot-data`), mapped to `/app/data` inside the container.

---

## 🛠 Prerequisites

1. **Docker & Docker Compose** installed on the host machine.
2. **RingCentral Developer Account** with a "Private Bot" application created.
3. **Jira API Credentials** (Email, API Token, and Hostname).
4. **Ngrok Auth Token** (a free or paid account at ngrok.com).

---

## 🚀 Deployment Steps

### 1. Clone the Repository
Pull the code to your deployment server:
```bash
git clone <repository_url> JiraQuarterBot
cd JiraQuarterBot
```

### 2. Configure Environment Variables
Copy the template file to create your active environment configuration:
```bash
cp env-template .env
```

Open `.env` in your preferred editor and fill in the following values:
* `RINGCENTRAL_CLIENT_ID` — Your RingCentral App Client ID.
* `RINGCENTRAL_CLIENT_SECRET` — Your RingCentral App Client Secret.
* `JIRA_HOST` — e.g., `jira.mycompany.com`.
* `JIRA_EMAIL` — The email of the service account used for Jira queries.
* `JIRA_API_TOKEN` — The Jira API token for the service account.
* `NGROK_AUTHTOKEN` — Your ngrok authentication token.

*(Note: You do **not** need to manually define the webhook URLs in `.env`. The entrypoint script will handle them automatically).*

### 3. Build and Start the Containers
Start the application in detached mode:
```bash
docker compose up -d --build
```

You can tail the logs to ensure both containers start up successfully:
```bash
docker compose logs -f bot
```

Look for the log output:
```
✅ ngrok tunnel: https://<random-id>.ngrok.io
🚀 Starting bot…
```

---

## 🤖 Bot Installation & Token Persistence

Because this is a **Private RingCentral Bot**, it functions on an effectively permanent access token. However, when you boot it for the very first time on a fresh environment, it won't have a token yet.

### First-Time Installation
If your `bot-data` volume is completely empty, the logs will say:
> `Your bot has not been installed or the saved access token was lost!`

To install it:
1. Log in to the [RingCentral Developer Portal](https://developers.ringcentral.com/).
2. Open your App and navigate to the **Bot > General Settings** tab.
3. Click the **Remove** button (if it's already installed).
4. Click the **Add to RingCentral** button.

RingCentral will send a webhook containing your permanent Bot Access Token to the active ngrok URL. The bot will save this token into the `bot-data` volume.

### Migrating an Existing Token (Optional)
If you already have a valid `.private-bot-auth` file and want to migrate it into the Docker volume to avoid reinstalling the bot:

1. Bring the containers up so the volume is created: `docker compose up -d`
2. Copy your local token file into the bot container:
   ```bash
   docker cp .private-bot-auth jiraquarterbot-bot-1:/app/data/.private-bot-auth
   ```
3. Fix permissions so the `bot` user can read it:
   ```bash
   docker exec -u root jiraquarterbot-bot-1 chown bot:bot /app/data/.private-bot-auth
   ```
4. Restart the bot:
   ```bash
   docker compose restart bot
   ```

---

## 🔄 Updating and Maintenance

### Applying Code Updates
When you pull new code from the repository, rebuild the lightweight Node.js image:
```bash
git pull
docker compose up -d --build
```
Because the access tokens are persisted in the `bot-data` volume, they will survive the container rebuild automatically.

### Important Note on Ngrok Free Tier
If you are using a **Free Ngrok Account**, ngrok will generate a brand new URL every time you run `docker compose down` and `docker compose up`. 