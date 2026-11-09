# Cloudflare Workers deployment checklist

1. Push this repository to GitHub.
2. In Workers Builds, use:
   - Root directory: `/`
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
3. Create a PostgreSQL database with a provider that supports a standard PostgreSQL connection string.
4. Run the schema migration from a trusted machine:
   `DATABASE_URL="..." npm run migrate`
5. Create Cloudflare Hyperdrive:
   `npx wrangler hyperdrive create workdesk-db --connection-string="..."`
6. Copy the returned ID into `wrangler.jsonc`:

```jsonc
"hyperdrive": [
  {
    "binding": "HYPERDRIVE",
    "id": "YOUR_REAL_HYPERDRIVE_ID"
  }
]
```

7. Set the JWT secret:
   `npx wrangler secret put JWT_SECRET`
8. Commit `wrangler.jsonc` and push. Cloudflare will build and deploy.
9. Open the Worker URL and choose **First time? Set up workspace** to create the first administrator.

`ASSETS` is configured in `wrangler.jsonc` under `assets.binding`. It points to `./client/dist`. `run_worker_first` routes `/api/*` through `worker.js`, while the rest of the application is served from the React build.

Do not commit database URLs, database passwords, JWT secrets, or production credentials.
