# RefineCalc Pro — Enterprise Refinery Quote Desk & Transporter Price Optimizer
**Goverdhan Energy & Petrochemicals Pvt. Ltd.**

---

## 🔒 Security & Architecture Overhaul (Resolved Findings H-01 to H-24 & S-01 to S-16)

This release resolves all 40 critical, high, and medium vulnerabilities identified in the November 2026 Code Review:

1. **Server-Side Authentication & Session Tokens (`S-01, S-02, S-08, H-01, H-02, H-03, H-13, H-20`)**:
   - Removed all hardcoded backdoor passwords (`admin123`, `7256@Mk`), default admin credentials, and Master Recovery Keys (`GEPL2026`, `7256`).
   - Passwords are salted and hashed using Node.js native `scrypt` (or `bcryptjs`). Plaintext passwords and hashes are never exposed to clients.
   - Sessions are managed via 256-bit secure cryptographic session tokens (`app_sessions` table and HTTP-only `rc_session` cookie / Bearer token).
   - Every API endpoint requires authentication and enforces role permissions (`admin` vs `user` vs `viewer`).
   - Rate limiting applied to `/api/auth/*` routes to prevent brute-force attacks.

2. **Secure Static Serving (`S-03`)**:
   - `server.js` serves static web assets strictly from the `public/` directory (`public/index.html`).
   - The root project directory, `server.js`, `package.json`, and `.env` are completely isolated and cannot be downloaded by URL.

3. **Database Write Integrity & Anti-Wipe Protection (`S-04, S-06, S-09, H-04`)**:
   - Database writes persist to Neon PostgreSQL first before updating in-memory cache, returning 500 immediately if Neon fails.
   - Database pool configured with error handlers, 10s connection timeouts, 30s idle timeouts, and max 10 clients.
   - Removed `replaceAll` parameter from the client entirely.
   - "Reset Default Master Data" requires typing `RESET MASTER DATA` in a confirmation prompt.
   - Server awaits `initDatabase()` before binding port, returning 503 if hydrating to prevent cold-start races.

4. **Atomic Quotation Sequences & Append-Only History (`S-05, S-07, H-06, H-07, H-08, H-11`)**:
   - Quotation sequence numbers are generated atomically on the server via `POST /api/quotes/next-number` using row-level locking on `app_quote_sequences`.
   - Financial year label (e.g. `26-27`) is derived from the server's calendar clock.
   - Saved quotes and audit logs are stored in dedicated PostgreSQL tables (`app_quotes`, `app_quote_logs`) with verified session author stamping.
   - Optimistic concurrency control via key versions rejects stale overwrites with HTTP 409 Conflict.

5. **Client-Side Draft Isolation & Role Preview (`H-09, H-10`)**:
   - `workspaceState` (calculator inputs, customer name, draft line items) is stored in browser `localStorage` per user only and is never synced across devices or users.
   - Role switching for Admins is an in-memory client simulation (`S.previewRole`) that never modifies the database.

6. **Input Validation, Geocoding Debounce & Formula Sanitization (`H-12, H-14, H-15, H-16, H-17, H-18, H-21, S-10, S-11, S-12`)**:
   - All IDs and units are escaped with `esc()` in HTML tables.
   - Clamped discount between 0 and `maxDiscount`; warns on negative margin.
   - Geocoding lookups debounced by 500ms with a negative cache for failed lookups; freight is not guessed while town is locating.
   - CSV export sanitizes values starting with `=`, `+`, `-`, `@` to prevent spreadsheet formula injection.
   - Replaced 2.5s full-table download with lightweight `/api/storage/status` check every 30s + real-time SSE stream.
   - Request body limit set to 5MB, whitelisted storage keys, and prototype pollution blocked.

---

## 🚀 Environment Variables (Render & Neon)

Configure these in your Render Dashboard under **Environment**:

| Variable | Description | Example |
| :--- | :--- | :--- |
| `DATABASE_URL` | Neon PostgreSQL Connection String (with SSL) | `postgres://user:pass@ep-xyz.neon.tech/neondb?sslmode=require` |
| `ADMIN_EMAIL` | Initial Master Admin Gmail Address | `dmegepl@gmail.com` |
| `ADMIN_PASSWORD` | Initial Master Admin Password | *Set a strong, unique password* |
| `ADMIN_NAME` | Initial Master Admin Full Name | `Mohsin Khan` |
| `NODE_ENV` | Runtime environment | `production` |
| `PORT` | Listening port (assigned by Render) | `3000` |
| `ALLOWED_ORIGINS` | Optional CORS allowed origins | `https://your-app.onrender.com` |

---

## 🛠️ Deployment on Render

1. **Extract Zip**: Extract `refinecalc_app.zip` into your repository.
   ```
   ├── public/
   │   └── index.html        # Hardened client application
   ├── server.js             # Hardened Express server
   ├── package.json          # Node dependencies
   ├── schema.sql            # PostgreSQL schema & tables
   └── README.md
   ```
2. **Git Commit & Push**:
   ```bash
   git add .
   git commit -m "feat: enterprise security overhaul and database hardening"
   git push origin main
   ```
3. **Render Build & Start Commands**:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. **First Login**:
   - Log in with your configured `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
   - In **User & Admin Security (`🔐`)**, review team sign-ups, approve access levels, or invite new sales team members.
