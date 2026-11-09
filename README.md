# TotalPay WorkDesk

One application codebase for Cloudflare Workers and AWS. The React UI, Hono API routes, authentication, authorization rules, and PostgreSQL schema are shared. Only the runtime entry point and database connection configuration differ.

## Stack

- React + Vite + PWA
- Hono API (same routes on Cloudflare Workers and Node.js)
- PostgreSQL (same schema and SQL on both platforms)
- Postgres.js with `prepare: false`
- JWT authentication with `jose`
- Password hashing with `bcryptjs`
- Cloudflare Workers + static asset binding for initial hosting
- Docker + Node.js for AWS deployment

## Repository layout

```text
totalpay_workdesk/
├── backend/
│   ├── src/app.js          # Shared API and authorization logic
│   └── node.js             # Node.js/AWS entry point
├── client/                 # React + Vite + PWA
├── database/
│   ├── migrations/
│   └── schema.sql
├── scripts/migrate.js
├── worker.js               # Cloudflare Workers entry point
├── wrangler.jsonc
├── Dockerfile
└── docker-compose.yml
```

## 1. Local development

Requirements: Node.js 20+ and PostgreSQL 14+.

```bash
npm install
npm run install:client
```

Create a PostgreSQL database named `workdesk`, then set environment variables.

Linux/macOS:
```bash
export DATABASE_URL="postgres://USER:PASSWORD@localhost:5432/workdesk"
export JWT_SECRET="use-a-random-secret-at-least-32-characters-long"
npm run migrate
npm run dev
```

PowerShell:
```powershell
$env:DATABASE_URL="postgres://USER:PASSWORD@localhost:5432/workdesk"
$env:JWT_SECRET="use-a-random-secret-at-least-32-characters-long"
npm run migrate
npm run dev
```

Open http://localhost:5173. Vite proxies `/api` to the Node API at port 4000.

## 2. First-time workspace setup

There are no hard-coded demo accounts or default passwords.

1. Open the application.
2. Select **First time? Set up workspace**.
3. Create the first Super Admin with a unique official email and a password of at least 12 characters.
4. The bootstrap endpoint closes automatically once the first user exists.
5. The Super Admin can create managers, employees and teams from Settings.

The bootstrap endpoint is `/api/auth/bootstrap`. It can only create the first account when the users table is empty.

## 3. Cloudflare Workers deployment

### Database

Use a PostgreSQL provider that is reachable through Cloudflare Hyperdrive (for example, a PostgreSQL service with a compatible connection string). The application uses PostgreSQL on both Cloudflare and AWS; it does not use D1 or SQLite.

Create the schema once from your development machine:

```bash
DATABASE_URL="YOUR_POSTGRES_CONNECTION_STRING" npm run migrate
```

PowerShell:
```powershell
$env:DATABASE_URL="YOUR_POSTGRES_CONNECTION_STRING"
npm run migrate
```

### Create Hyperdrive

Install dependencies and authenticate:

```bash
npm install
npx wrangler login
```

Create a Hyperdrive configuration using the same PostgreSQL connection string:

```bash
npx wrangler hyperdrive create workdesk-db --connection-string="YOUR_POSTGRES_CONNECTION_STRING"
```

Cloudflare prints a Hyperdrive ID. Edit `wrangler.jsonc` and add the returned ID:

```jsonc
"hyperdrive": [
  {
    "binding": "HYPERDRIVE",
    "id": "PASTE_THE_REAL_HYPERDRIVE_ID_HERE"
  }
]
```

Add this block at the top level beside `assets` and `compatibility_flags`. Do not leave a placeholder ID in the deployed file.

Set the JWT signing secret:

```bash
npx wrangler secret put JWT_SECRET
```

Paste a long random secret when prompted. Do not commit real secrets or database passwords to GitHub.

### Workers Builds settings

In Cloudflare → Workers & Pages → your Worker → Settings / Builds:

| Field | Value |
|---|---|
| Root directory | `/` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Preview command | Leave empty (or use `npx wrangler dev` locally) |

The root build script installs the client dependencies and builds React into `client/dist`. `wrangler.jsonc` maps that directory to the `ASSETS` binding. `worker.js` routes `/api/*` to the shared Hono API and serves the static React app through Cloudflare's asset binding.

After adding the Hyperdrive binding and JWT secret, push the changes to GitHub. Workers Builds will install the root dependencies, run the build command, and deploy the Worker.

### Cloudflare free-tier note

The Worker/static hosting may fit within Cloudflare's free plan limits, but PostgreSQL is a separate service. Hyperdrive connects to PostgreSQL; it does not provide a database. A PostgreSQL provider may have its own free tier, usage limits, sleep/compute constraints or charges. Check the provider's current terms before production use.

## 4. AWS deployment (same application code)

The Docker image runs `backend/node.js`, which mounts the exact same Hono API from `backend/src/app.js` and serves the same React build. No separate AWS business logic is maintained.

For a quick Docker deployment:

1. Copy `.env.example` to `.env`.
2. Set strong `POSTGRES_PASSWORD` and `JWT_SECRET` values.
3. Start the application and PostgreSQL:

```bash
docker compose up -d --build
```

4. Run the migration inside the app container:

```bash
docker compose exec workdesk npm run migrate
```

5. Open port 4000 behind HTTPS/Nginx or an AWS load balancer.

For AWS production, use RDS PostgreSQL rather than the bundled PostgreSQL container. Set `DATABASE_URL` to the RDS connection string and deploy the same Docker image to ECS, EC2 or another Node.js container service.

## 5. Moving PostgreSQL data to AWS

The code and schema stay the same, but database data must be migrated separately. Use PostgreSQL `pg_dump` and `pg_restore` (or the provider's managed migration service), verify row counts and application access, then switch `DATABASE_URL` to RDS.

## 6. Security and production checklist

- Use HTTPS for all production traffic.
- Store `JWT_SECRET` as a Cloudflare secret or AWS secret/environment variable; never commit it.
- Use a unique strong password for the first administrator.
- Use a restricted database user for the application.
- Restrict database network access to Cloudflare Hyperdrive / AWS application networking.
- Configure automated PostgreSQL backups and test restoration.
- Add MFA/SSO, password reset, audit logs, account lockout and rate limiting before broad company rollout.
- Review employee/manager access rules with stakeholders before production.
- Keep staging and production databases separate.

## Notes

- The official TotalPay logo is stored at `client/public/totalpay-logo.png`.
- No Express, SQLite, `better-sqlite3`, or D1 backend remains in this portable package.
- The Cloudflare Worker and AWS Node adapter import the same `backend/src/app.js`.
