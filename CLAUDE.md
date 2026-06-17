# Propoint — Projektuotojų užduočių valdymo sistema

Node.js/Express + React 18 web app for managing design project tasks at a Lithuanian company. Single-file frontend (`public/index.html`) with Babel standalone — no build step. Backend is `server.js`. Data stored in SQLite via `better-sqlite3`.

## Version policy

Increment the minor version (`1.X.x`) with every change. Update the version string in **both** `index.html` (title/display) **and** `package.json`.

## Tech stack

- **Backend:** Node.js, Express, better-sqlite3 (WAL mode), ldapjs v3, multer, nodemailer
- **Frontend:** React 18 UMD + Babel standalone, Recharts, single HTML file
- **Process manager:** PM2. Env vars set via `pm2 set propoint VAR value`
- **Deployment:** GitHub → server polls via cron + `deploy.sh` every minute

## Auth

- **Local admin:** username `proadmin`, role `admin`, `adAuth: false`, default password `Energo99`
- **AD users:** two-step LDAP — UPN bind to verify password, then service account search for name/email
- **LDAP server:** `ldap://192.168.1.100:389`, base DN `DC=hata,DC=local`
- Sessions stored in browser **localStorage** (not server-side)
- Passwords never sent to client

## Key files

| File | Purpose |
|------|---------|
| `server.js` | Backend, all API routes, LDAP auth, file upload, email |
| `public/index.html` | Entire frontend (React components, styles, logic) |
| `package.json` | Version tracking |
| `CLAUDE.md` | This file — architecture docs |

## Roles

- `admin` — komandos vadovas: full access, assigns tasks, approves, manual status changes
- `designer` — projektuotojas: receives tasks, submits coordination requests
- `pending` — new AD user awaiting role assignment

## Task statuses

`new` → `assigned` → `in_progress` → `coordination` → `review` → `completed` / `rejected`

## Language

UI and console logs are in **Lithuanian**. Code comments and variable names in **English**.

## Email

SMTP: `10.2.1.103:25`, from `propoint@energolt.eu`

## File uploads

Stored in `uploads/` dir. Max 500 MB, max 70-char filename. Served via `/uploads/` static route.

## Deployment review policy

Any change that modifies the **database schema or existing data** must go through an **additional review cycle in Claude Cowork** before deployment.

## PM2 commands

```bash
pm2 restart propoint --update-env
pm2 logs propoint
pm2 set propoint LDAP_SVC_PASS <password>
pm2 set propoint LDAP_USERS_BASE "OU=Users,DC=hata,DC=local"
```
