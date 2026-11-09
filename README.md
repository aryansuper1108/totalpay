# TotalPay WorkDesk — React + Express + SQLite + PWA

## Included
- React + Vite frontend
- Express API
- SQLite persistence
- JWT login and bcrypt password hashing
- PWA manifest, icons and service worker
- Installable from supported mobile browsers (HTTPS required in production)
- Role-aware organization planner:
  - ADMIN: organization-wide access; browse teams and member planners; multiple administrators are supported
  - MANAGER: only their assigned team and its member planners; manager can open a member's individual planner
  - EMPLOYEE: own planner and tasks assigned/shared with them; other employees' personal planners are not visible
- Admin-only user creation and team creation
- Department-scoped development requests (Technical + Admin)
- Mobile responsive UI with same sidebar/navigation model and mobile bottom navigation

## Demo accounts
All demo passwords: `Demo@123`

- CEO / Super Admin: `admin@totalpay.local`
- Manager Taj: `taj@totalpay.local`
- Employee Aryan Rana: `aryan@totalpay.local`

Seed data creates Taj Team (Technical), Taj as its manager, Aryan Rana and Neha Patel as members, plus sample planner tasks. Admins can create additional teams and assign members during user creation.

## Local development
Requires Node.js 20+.

```bash
npm install
npm install --prefix client
npm install --prefix server
npm run dev
```

Frontend: http://localhost:5173  
API: http://localhost:4000

The root `npm install` installs the concurrently helper. Client and server dependencies are installed separately as shown.

## Production with Docker

1. Set a long random `JWT_SECRET` in `.env`.
2. Run:

```bash
docker compose up -d --build
```

3. Open `http://YOUR_SERVER:4000` (put behind HTTPS Nginx before real use).
4. Persistent SQLite database is stored in the Docker volume `workdesk-data`.

## Install on phone
Deploy behind HTTPS using a valid certificate, then open the WorkDesk URL in Chrome on Android or Safari on iPhone:
- Android/Chrome: browser menu → Install app / Add to Home screen.
- iPhone/Safari: Share → Add to Home Screen.

No Play Store or App Store listing is required. PWA installation requires HTTPS (localhost is exempt for development).

## Important production hardening
This is a functional starter application, not a security-audited production release. Before real company use:
- Change all demo passwords and set a strong JWT_SECRET.
- Add password reset, MFA/SSO, account lockout and session revocation.
- Configure HTTPS, restrictive CORS, rate limiting, secure headers and request validation.
- Add team membership administration, audit events, notifications, file attachments and backup/restore procedures.
- Review whether managers may edit every team task or only tasks assigned to their team.
- Add database migrations and automated tests.
- Ensure backups are encrypted and access is restricted.

The API enforces the key visibility boundaries server-side; frontend hiding is not used as the security boundary.
