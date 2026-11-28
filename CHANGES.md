# Version 3.2: price lists can be Excel, CSV or PDF (and a bitumen / product-matching fix)

1. **One upload that reads whatever you give it.** Every upload button (Upload file, Smart Upload, drag and drop on the rates box, Transport and Transporters uploads) now accepts `.xlsx`, `.xls`, `.csv`, `.tsv`, `.txt` and `.pdf`. The file is turned into rows of cells first, then goes through the same "Check these prices / Save these rates" screen as before. Nothing is saved until you click Save, and only an Admin can upload.
   - **PDF:** the page is read by layout with pdf.js (included in `public/vendor/pdfjs/`, no internet needed). Table lines are detected, merged cells (for example one *LDO* cell covering 8 refineries) are filled down the way Excel does it, multi-page tables are joined and repeated headers are removed. Your `PRICE_LIST_FUELS_new_1.pdf` reads as 18 priced rows with *Prices effective 16 Nov 2026*; the "0.00" rows are left out, like in the Excel flow.
   - **CSV / TSV / TXT:** comma, semicolon, tab, `|` or 2+ spaces are detected automatically; Excel's `sep=;` line, quotes, UTF-8 / UTF-16 / Windows-1252 text and numbers like `1,07,720.50` are understood.
   - **What it will not read:** scanned PDFs and photos (they contain no text; the app says so and imports nothing), password-protected PDFs, Word/PowerPoint files. A short message explains each case.
   - **Always compare before saving.** PDFs are read by layout, so the preview shows an amber note asking you to check the numbers. PDFs without table lines work too, but merged cells can then land on the wrong row, so check those twice.
2. **Product-matching fix (found while testing the PDF).** Names like `BIT (BULK) 80/100 (VG 10)`, `BIT (BULK) 60/70 (VG 30)` and `BIT (BULK) (VG 40)` all got the same internal id (`BULK`), so only one of the three prices survived the save. Same for `FURNACE OIL (MT)` and `RIL FURNACE OIL (MT)` (id `MT`). Fixed in two ways: new products always get an id that is unique inside the import, and a name now finds the product already in your list when the bracketed code matches (`(VG 10)` finds *Bitumen VG-10 (VG10)*) or when it differs only by a unit tag (`FURNACE OIL (MT)` finds *Furnace Oil (FO)*). If a name matches nothing, a new product is added as before.
3. **Units from the price list.** A `UNIT` column (for example `RS/KL`) is now used when a new product is created, so LDO and MTO are created as KL, not MT.
4. **Sign-in no longer gives up after 8 seconds.** On Render's free plan the server goes to sleep and takes up to a minute to wake, so the old sign-in showed *"Cannot reach authentication server"* even with the right password. Sign-in now waits up to 70 seconds, retries while the server or database is still starting, and shows *"still starting up"* / *"did not answer in time"* messages that say what is happening. A wrong password is still answered immediately.
5. **"Back to Admin" can no longer be lost.** While an Admin previews the Edit or Quote view, a bar at the bottom of the screen always shows **Back to Admin**. The preview is never saved, so refreshing the page also returns to Admin.
6. **The real reason the database is not connected is now shown.** `/health` (also `/api/health`) adds a plain-words `dbHint` when the database is not ready, for example *Neon rejected the database password...* (the usual result of changing the Neon password without updating `DATABASE_URL` on Render). The Customer screens and the "Could not save to the cloud" message show this hint instead of "retry in a few seconds". No password or connection string is ever shown.
7. **Damaged bitumen / product data is repaired automatically.** If your catalog already contains products that share one id (the three `BIT (BULK) ... (VG 10 / VG 30 / VG 40)` rows saved by an older build), the page merges them into the existing *Bitumen VG-10 / VG-30 / VG-40* products, gives any other duplicate its own id, and removes the prices that were saved under the shared id (they could not be trusted). It shows a message; upload the latest price list again and all three bitumen grades save with their own prices. Product names such as `VG 10` now also match a product whose name is just that code.
8. **Customer screens explain themselves.** Reading customers is retried while the server wakes up. If it still fails, the message says whether the server is asleep/offline, or running with its Neon database not connected (with the reason when the new `server.js` is deployed).

Checked: 43 browser checks (real PDF, 5 other PDF layouts, 3-page PDF, 6 CSV/TXT variants, 7 refusal cases, save and re-upload, no console errors) plus the earlier server and screen checks. The real `.xlsx` binary reader (SheetJS) was not changed, but it could not be run in the test sandbox, so please try one Excel file after you deploy.

**Deploy note:** copy ALL files of this folder (server.js, crm.js, index.html and the new `public/` folder), not only index.html, then commit. In particular `server.js` carries the database-reason messages. Commit the new folder `public/vendor/pdfjs/` (3 files, 1.8 MB) with the rest. If those files are missing the page falls back to loading pdf.js from jsDelivr, which needs internet.

---

# Version 3.1: two fixes (upload of the wrong file type, no-database message)

1. **Uploading a PDF (or Word file, picture, empty file) as a price list.** The Excel importer used to read a PDF's raw bytes as if it were a table, which produced a "header mapper" with one column called `%PDF-1.5` and everything else ignored. Now every upload path (Smart Upload, sidebar *Upload .xlsx*, drag and drop on the rates box, Transport and Transporters uploads) first looks at what the file really is. A PDF, picture, Word/PowerPoint/zip file, binary junk or an empty file gets a clear message and nothing is imported. Real `.xlsx`, `.xls` and `.csv` files go to the normal reader exactly as before. Only the start of `uploadMaster` changed (one added line plus the new checking function next to it).
   - The file chooser only lists Excel/CSV files, which is why a PDF does not show up in your Downloads folder when you click Upload. That is expected: the importer cannot read PDFs. Dragging a PDF onto the page used to bypass the chooser; now it gets the message instead of garbage.
   - **A PDF price list still has to be converted to Excel first.** Reading PDF circulars directly would need a PDF reader built around your actual PDF layout. Send me the PDF and I can add that.
2. **"This section could not load. Customer features need the Neon database."** This message means the server you are running has no `DATABASE_URL`. It is now a step-by-step panel (Render and VS Code versions) with an "I've done this, check again" button that works without reloading the page. The calculator, price lists and Saved Quotes work without a database, as before; only customers, quotation history and email records need it.

Checked again after the changes: 133 server checks, 107 + 19 + 25 browser checks, and the same-steps comparison with your original `index.html` (120 price combinations, all 12 screens, Save Quotation, PDF) are all clean.

---

# Version 3: Customer Master, emailed quotations, quotation history and rate analysis

New code is kept apart from the old code: one new file (`crm.js`), six new database tables (all start with `crm_`), and small additions to `server.js` and `index.html`. Nothing was removed or rewritten.

## What you get

| You asked for | Where it is |
|---|---|
| Customer Master: add, edit, search, history, no duplicates | **Customer Master**. Hard stop for a repeated GST number; a warning (you can still confirm) for the same email or a similar name in the same city. Edits are versioned; customers are archived, never deleted |
| Pick an existing customer or add a new one while quoting | Calculator: *Pick customer* / *New* under the customer name box |
| Best 3 options, select / deselect, preview, edit subject and message | Panel under the calculator result (*Review & email*). Best 3 are pre-ticked; up to 5 can be sent; preview is rendered by the server, so it is exactly what the customer receives |
| Send to the registered email, resend, keep a copy | Two-step confirm. PDF is attached. Every attempt is stored with its full text, and *View copy* shows it again |
| Quotation History with unique id, status, email record, remarks | **Quotation History**. IDs look like `QT-2026-00001`. One quotation holds all its options |
| Customer timeline, revisions, remarks, filters | Open a customer. Filters: date range, product, refinery, employee, status |
| Rate history and analysis per customer and product | **Rate History / Analysis**: lowest / highest / latest, change since last quote, chart. Internal only |
| Dashboard numbers | Top of **Quotation History**: customers, quotations generated and sent, sent this month, failed emails, recently quoted customers, recent activity |
| Activity log | **Activity Logs** (admin only). Permanent |

## Rules the system enforces (not just the screens)

- Numbers (`CUS-00001`, `QT-2026-00001`) come from the database in one transaction, so two people saving at the same moment can never get the same number.
- A saved quotation's options are a **frozen snapshot** (refinery name, rate, GST, credit, quantity, customer details used). The database itself refuses to change or delete them, so later edits to the customer or the price list cannot alter an old quotation. The activity log is protected the same way.
- A quotation is marked **Sent** only after the email service confirms it accepted the message. If the service rejects it, the quotation shows **Failed** with the reason. If the answer is lost (timeout, crash), it is marked **Not confirmed** and you are told to check before sending again.
- Pressing Send twice, or retrying after a network error, never sends a second email: every send carries a one-time key and the server remembers it. *Resend* is a deliberate, separate action with its own warning.
- Sending is blocked unless the customer has a valid email, the email service is configured and `SITE_PASSWORD` is set. The API key is read from environment variables only. Emails contain product, refinery, delivery town, rate, GST and credit; the internal cost breakdown (basic price, freight, margin) is stored for your reference but never put in an email.

## What changed in your existing files

`server.js`: 18 lines added, none removed (load `crm.js`, start it in the background after the database is ready, register its routes). If the new tables cannot be created, the server logs it and retries every 15 seconds; the old app is not affected.

`index.html`: 3 existing lines were extended and everything else is additions:
1. the list of screens (`TABS`) gained four names,
2. the "admin only" check also covers Activity Logs,
3. the screen table gained four entries,
4. plus one line each in the calculator form, the result panel and the result-binding code that call the new panels, one line that clears the open customer when you click another menu, new menu links, CSS for the new windows, and the new code block placed just before `boot();`.

Checked against your original file: the pricing results for 120 combinations of product, town, quantity, margin and discount, the text of all 12 existing screens, "add to quotation", Save Quotation, the Saved Quotes log and the PDF file are identical.

## Decisions you should know about

1. **New tables in Neon instead of the existing key-value store.** Unique numbers, permanent records and safe email retries need real database rules. Your old data is untouched.
2. **The old "Saved Quotes Log" and its numbers (`GEPL-Q-26-27-0002`) are kept and still work.** New quotations use the new `QT-` numbers and live in Quotation History. They are two separate lists; I did not merge them because that would have changed existing behaviour.
3. **One calculation = one quotation = one email**, with up to 5 options. A changed quantity or margin is a *Revise*: it gets a new number and the old one is marked Revised, never overwritten.
4. **Email goes through an email service (Brevo or Resend), not Gmail/SMTP from the browser.** Keys cannot be kept safely in a web page.
5. **`SITE_PASSWORD` is mandatory for sending.** Your app's own login runs in the browser, so without a site password anyone with the address could use the send button.

## Not done / limits

- **"Sent by" and "Created by" are the name of the person signed in on that browser.** The app's login is still browser-side (see the earlier list below), so the server cannot prove who clicked. This becomes reliable once the real server login is built.
- The hard-coded admin passwords and recovery key from the earlier review are still in the page. Please set a real admin password and let me remove them next.
- Not tested against a real Brevo or Resend account, or your real Neon database. See "How this was tested".

## How this was tested

- Server: 133 checks against a real PostgreSQL 16 database (numbering under 12 simultaneous saves, duplicates, frozen records, send success / rejection / timeout / crash, double-click, resend, revisions, filters, rate history, stats, secrets never logged). The email service was a stand-in.
- Browser: 107 checks driving the real page against that server (create customer, duplicate warning, calculate, best 3, preview, edit, confirm, send, timeline, history, resend, failed email and retry, revise, rate history, activity log, permissions, phone width, dark mode), plus 19 checks with no database, email not set up, and a wrong API key.
- Same-steps comparison between your original `index.html` and this one (see above).
- The workspace cannot install the real `express` and `pg` packages, so tests used stand-ins; the stand-in `pg` speaks the real PostgreSQL protocol. Render will install the real packages.

## Before you deploy

1. Neon: make a backup or branch. GitHub: `git tag before-v3`.
2. Replace `server.js`, `index.html`, `package.json`, `README.md`, `CHANGES.md`, `schema.sql` and add **`crm.js`**. Commit and push; Render redeploys.
3. Check Render > Logs shows "Neon PostgreSQL hydrated and ready" and no "Customer module setup failed" line.
4. Open Customer Master, add a customer with your own email, make a quotation, and send it to yourself.

---

# Earlier update: security and reliability (kept for reference)

Only two files changed: `server.js` and `index.html`. About 120 lines of the 8,000-line page were touched; everything else is byte-for-byte the code you sent. The finding numbers (H-xx, S-xx) are from the review PDF.

## Fixed in `server.js`

| What | Finding |
|---|---|
| The project folder is no longer served. `server.js`, `package.json`, `schema.sql`, the README and the sample CSV can no longer be downloaded by URL. | S-03 |
| **Optional site password** (`SITE_PASSWORD`). When set, nobody can load the page, read the data or open the live-sync stream without it. Off by default, so nothing changes until you switch it on. | S-01 (stop-gap) |
| Saves go to Neon **first**. Memory and other devices are only updated after Neon confirms. If Neon fails, the page now gets an error instead of a false "success". Saves and reads run in one queue, so an old read can't overwrite a newer save. | S-04 |
| While Neon is still waking up, the API answers 503 ("not ready") instead of an empty store, and keeps retrying the connection. This closes the path where a restart could wipe the database. | S-06, H-04 |
| "Delete everything first" (`replaceAll`) is ignored by the server. | H-04 |
| Only the 14 data keys the page really uses are accepted. Unknown keys, `__proto__` and `_meta` are refused. Save size limit 15 MB (was 50 MB). Live-sync connections capped at 200. | S-10, S-11, S-12 |
| A client with a wrong clock can no longer push the sync revision far into the future. | S-05 (partly) |
| Database pool: error handler (no crash when Neon drops an idle connection), 10-second connection timeout, 5 connections. Certificate check available with `DB_SSL_STRICT=true`. | S-09 |
| `/api/auth/login` (not used by the page yet) refuses empty logins, pending/rejected accounts and locks an address out after 10 wrong tries in 15 minutes. | S-08 |
| Generic error messages, shorter `/health`, safe handling of empty request bodies, clean shutdown on Render deploys (SIGTERM). Optional CORS lock (`CORS_ORIGINS`). | S-15, S-16 |

## Fixed in `index.html`

| What | Finding |
|---|---|
| The Master Recovery Key text is no longer shown on the Forgot Password screen or in the "request sent" message. | H-01 (text only, see below) |
| A signed-out visitor's browser can no longer seed the database. "Push All" (both buttons) asks for confirmation first and no longer deletes anything. "Reset Default Master Data" needs you to type `RESET`. | H-04 |
| Failed cloud saves are no longer silent. The sync label shows "Not saved to cloud yet, retrying", a message explains it, and the page retries every 10 seconds until it works. Saves wait up to 30 seconds (was 8) so a sleeping Render server can wake up. | H-05 |
| Quote ids, units and user ids are escaped before being placed in the page. | H-12 |
| The audit CSV export neutralises cells that start with `=`, `+`, `-` or `@`. | H-17 |
| Only a signed-in editor uploads the auto-repaired catalog. | H-19 |
| Re-price no longer crashes when the quote was deleted on another device. Editing a field in the Approved table no longer turns a rejected user into an approved one. | H-24 |

## Deliberately NOT changed (needs a decision from you)

- **Login still runs in the browser** (H-03, S-02, H-13). Passwords are still stored as plain text and the page still downloads the user list. Fixing this properly means a real server login with hashed passwords and changes to the login code. I did not do it in this round because it touches the login screen and could lock your team out. **`SITE_PASSWORD` is the protection until then.** Turn it on.
- **The hard-coded passwords and the recovery key still work** (H-01 logic, H-02): `GEPL2026`, `7256`, `admin123`, `7256@Mk`. Only the on-screen text was removed. Removing them could lock the owner account out if it still uses one of them. Next step: set a new real admin password, then I remove the backdoors.
- Duplicate quotation numbers, last-save-wins between devices, shared quotation draft, role-preview changing real users, audit-trail identity (H-06 to H-11, S-05, S-07). These need a data-model change (one row per quote and user, server-made numbers).
- Pricing guards, location-lookup limits, CDN integrity hashes, 2.5-second polling, sign-out cleanup (H-14 to H-16, H-18, H-20 to H-23).

## Before you deploy

1. Make a Neon backup or branch.
2. In GitHub, tag the current working version (`git tag before-security-update`) so you can go back in one step.
3. Replace `server.js` and `index.html`, commit and push. Render redeploys by itself.
4. In Render > Environment, add `SITE_PASSWORD` (a long password) and save.

## After you deploy: 6 quick checks

1. Open `https://YOUR-SITE/server.js`. It must **not** show code.
2. Open the site. Your browser asks for the site password; after entering it, the normal login screen appears.
3. Sign in as admin and save a quick quote. The label at the bottom should say it is synced, not "Not saved to cloud".
4. Open the site on a second device or browser. The quote appears there.
5. Open Forgot Password. The recovery key is no longer printed on it.
6. In Render > Logs you should see "Neon PostgreSQL hydrated and ready".

If any check fails, revert to the tagged version and tell me what you saw.

## How this was tested

The patched server and page were run together in a browser: 69 server checks and 39 browser checks pass (login, saving, a second device, reload, restart with a slow database, failed saves and retry, site password, escaping, CSV export, confirmations). Your original code passes the "regular use" checks and fails the security ones, so the tests do detect the problems.

**Limit:** this workspace cannot install the real Express and Neon packages, so the tests ran on simple stand-ins for them. That is why the 6 checks above on your real deployment matter. Nothing was tested against your real Neon database or a real Render deployment.
