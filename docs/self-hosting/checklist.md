# Chapters Self-Hosting & Production Deployment Checklist

Before going public or admitting production users, verify each of the following configuration requirements.

---

## 1. Secrets & Credentials Pre-Flight

- [ ] **`CREDENTIALS_ENCRYPTION_KEY`**
  - **Why**: Used to encrypt third-party git repository tokens, SSH keys, and webhook secrets.
  - **Format**: 64-character hex string (32 bytes).
  - **Command**: `openssl rand -hex 32`
  - **Warning**: Unset = private repository credentials cannot be stored. Back this up securely; changing it renders previously stored credentials unrecoverable.

- [ ] **`POSTGRES_PASSWORD`**
  - **Why**: Database authentication password.
  - **Warning**: Must be set in `.env` **before** the `db-data` volume is initialized for the first time. Changing it in `.env` afterwards will cause authentication failure unless rotated inside PostgreSQL.

- [ ] **`SETUP_TOKEN`**
  - **Why**: One-time bootstrap token used to register the initial administrator account on `/setup`.
  - **Recommendation**: Set explicitly in `.env` (`openssl rand -hex 16`) or retrieve from `docker compose logs app` upon initial start.

---

## 2. Email Delivery (SMTP)

- [ ] **`SMTP_HOST`**
- [ ] **`SMTP_PORT`** (usually 587 or 465)
- [ ] **`SMTP_USER`**
- [ ] **`SMTP_PASS`**
- [ ] **`SMTP_FROM`** (e.g. `Chapters <noreply@yourdomain.com>`)

> **CRITICAL**: If `SMTP_HOST` is unset, outgoing emails are captured in memory and **never delivered**. Users will not receive signup verification or password reset links.

---

## 3. Network & Reverse Proxy

- [ ] **Reverse Proxy / TLS**: Route incoming HTTPS traffic to port `3000`.
- [ ] **WebSocket Proxying**: Ensure your reverse proxy (Caddy / Nginx / Traefik) passes the `Upgrade` header on `/collab`:
  ```nginx
  location /collab {
      proxy_pass http://localhost:3000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "Upgrade";
      proxy_set_header Host $host;
  }
  ```
- [ ] **`CORS_ORIGIN`**: Leave empty for standard single-origin hosting. If using a dedicated domain for an external API consumer, configure the allowed origin URL.

---

## 4. Node & Runtime Environment

- [ ] **Node Version**: When running natively without Docker, ensure Node `>=24.0.0` is installed (pinned in [`.nvmrc`](file:///.nvmrc)). Run `nvm use`.
- [ ] **Vector Extension**: PostgreSQL must have `pgvector` enabled (included by default in `pgvector/pgvector:pg17` image).
