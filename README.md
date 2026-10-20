\
# MTN Ghana Subscription Callback Dashboard

A login-protected Node.js / Express / EJS dashboard for daily reporting from `mtn_ghana.mtn_subscription_callbacks`.

## Features
- Admin login with bcrypt-hashed passwords stored in MySQL.
- Date-range dashboard, daily grouped metrics, responsive layout and print stylesheet.
- Activation base count: `SUB%` where `status_code` is `Insufficent balance` or `Activation Success`.
- Separate activation-success, insufficient-balance and retry-activation-success counts.
- Renewals: `REN%` with `charge_amt != 0`.
- Unsubscribes: `UNSUB%`.
- Calculated activation charge: `1.5` for each `SUB%` row with `charge_amt > 0`.
- Calculated renewal charge: `1.5` for each `REN%` row with `charge_amt > 0`.
- Calculated total charge: `1.5` for each `SUB%` or `REN%` row with `charge_amt > 0`.

The calculated charge is a custom reporting value, not the sum of the database's raw `charge_amt`. The dashboard shows the qualifying counts and calculated charges separately.

## Requirements
- Node.js 18+
- MySQL account with SELECT permission on `mtn_subscription_callbacks` and CREATE/INSERT/UPDATE permission on `dashboard_admins`.

## Installation
1. Extract the ZIP and enter the project folder.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create `.env` from the example:
   ```bash
   cp .env.example .env
   ```
   Set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME=mtn_ghana`, and a long random `SESSION_SECRET`. For production behind HTTPS, keep `NODE_ENV=production`. If using a reverse proxy, set `TRUST_PROXY=true` only if it is trusted and correctly configured.
4. Create the admin table:
   ```bash
   mysql -u YOUR_DB_USER -p mtn_ghana < schema.sql
   ```
5. Create or reset an admin password using the command line. The password is entered interactively and hidden:
   ```bash
   npm run admin:set-password -- admin
   ```
   It asks for a password twice, requires 12+ characters, and stores only a bcrypt hash. Use a different username if preferred.
6. Start:
   ```bash
   npm start
   ```
7. Open `http://YOUR_SERVER_IP:3000/login` (use HTTPS in production).

## PM2
```bash
pm2 start app.js --name mtn-ghana-dashboard --cwd /path/to/mtn_ghana_dashboard
pm2 save
```
Check:
```bash
pm2 logs mtn-ghana-dashboard --lines 100
curl -s http://127.0.0.1:3000/health
```

## Query notes
- The app uses the database name from `.env` and queries `mtn_subscription_callbacks` within that database.
- It uses `created_at` date boundaries and groups by `DATE(created_at)`.
- The status string `Insufficent balance` follows the spelling in the supplied SQL. If the real database stores a different spelling or capitalization, adjust the exact status comparison.
- The SQL treats lifecycle prefixes case-insensitively via `UPPER(TRIM(...))`.
- Date selection is interpreted using Ghana/Accra time for display/default date selection; ensure the MySQL connection/session and stored `created_at` timezone convention match the source data.
- Optional index on `created_at` is commented out in `schema.sql`. Check current indexes before creating a duplicate.
- A persistent production session store (e.g. MySQL-backed store or Redis) is recommended before deploying behind multiple app instances; the default Express MemoryStore is suitable only for initial/single-process testing.
- Configure HTTPS, a reverse proxy, firewall rules and backups before production use.
"# ghana_dashboard" 
