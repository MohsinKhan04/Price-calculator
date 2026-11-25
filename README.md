# RefineCalc Pro — Internal Refinery & Transport Price Calculator

An enterprise price calculation and logistics optimization engine for industrial petroleum/chemical distribution.

## Formula Implementation:
- **Net Refinery Price** = `Basic Price - Refinery Discount`
- **Customer Price** = `Net Price + Margin + Transport Freight Cost`
- **Total Order Value** = `Customer Price × Order Quantity (MT)`

## Deployment Guide (GitHub + Neon + Render):

### Step 1: Set up Neon Database
1. Go to [Neon.tech](https://neon.tech) and create a free PostgreSQL project.
2. Open the **SQL Editor** in your Neon dashboard.
3. Paste and execute the contents of `schema.sql`.
4. Copy your PostgreSQL connection string (`postgresql://user:pass@ep-xxxx.neon.tech/neondb?sslmode=require`).

### Step 2: Push to GitHub
1. Create a new GitHub repository (e.g. `refinecalc-app`).
2. Commit all files in this project:
   ```bash
   git init
   git add .
   git commit -m "Initial commit for RefineCalc internal app"
   git remote add origin <your-repo-url>
   git push -u origin main
   ```

### Step 3: Deploy on Render
1. Go to [Render.com](https://render.com) and click **New + > Web Service**.
2. Connect your GitHub repository.
3. Settings:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
4. Under **Environment Variables**, add:
   - `DATABASE_URL`: *(Your Neon Connection String)*
   - `PORT`: `10000`
5. Click **Create Web Service**. Your live URL will be ready in 1-2 minutes!

## Customers, emailed quotations and history (version 3)

New menu group **Customers & Quotations**: Customer Master, Create & Email Quotation, Quotation History, Rate History / Analysis, and (admin only) Activity Logs under the admin section. Your calculator, price lists and the old "Saved Quotes Log" work exactly as before.

**Needs:** the Neon database (`DATABASE_URL`). The new tables are created automatically on the first start; you do not run any SQL. Without the database the old app works as before and the new screens say "needs the database".

### Turn on sending email (3 steps)

Sending is **off** until all of this is set, so nothing can be emailed by accident.

1. Make a free account with an email service. Brevo (brevo.com) and Resend (resend.com) are supported. Add and verify the address you want quotations to come *from*, and create an **API key**. (Menu names change from time to time; look for "Senders" and "API keys".)
2. In Render > Environment add:

| Variable | What it is |
|---|---|
| `EMAIL_PROVIDER` | `brevo` or `resend` |
| `EMAIL_API_KEY` | the API key from step 1. It lives only on the server; the web page never sees it |
| `EMAIL_FROM_ADDRESS` | the verified sender address, for example `quotes@yourcompany.com` |
| `EMAIL_FROM_NAME` | optional, the name customers see, for example `Goverdhan Energy & Petrochemicals` |
| `EMAIL_REPLY_TO` | optional, where customer replies should go |
| `EMAIL_BCC` | optional, an internal address that gets a hidden copy of every quotation |
| `EMAIL_MAX_PER_HOUR` | optional safety limit, default `60` |
| `SITE_PASSWORD` | **required for sending** (see the optional settings below). Without it anyone who finds the web address could send email from your address, so the server refuses |
| `APP_TIMEZONE_OFFSET` | optional, default `+05:30`; decides the year in `QT-2026-00001` and "this month" |

3. Save, let Render redeploy, then send **one test quotation to yourself** before using it with customers.

Tip: a company-domain sender (with the service's SPF/DKIM setup) reaches inboxes far more reliably than a free Gmail/Yahoo address.

### How to use it

1. **Customer Master**: add each customer once (name/company, contact person, mobile, email, billing address, city, state, GST, type, notes). The app warns before you create a customer that looks like one you already have, and refuses a GST number that exists already.
2. **Create & Email Quotation**: in the calculator, click *Pick customer* (or *New*), then calculate as usual. A panel shows the **best 3 refineries**; click *Review & email*. Tick or untick refineries (up to 5), edit subject and message, check the exact preview, then press *Send* and confirm. Nothing is ever sent without that second confirmation.
3. **Quotation History**: every quotation with its number, customer, refineries and exact rates, sent date/time, who sent it, status (Draft / Sent / Failed / Revised) and the saved email copy. Use *Resend*, *Revise* (makes a new numbered quotation and marks the old one Revised) or *PDF*.
4. **Customer profile** (open a customer): full timeline with filters for date, product, refinery, employee and status, and internal remarks per quotation.
5. **Rate History / Analysis**: pick a customer and product to see lowest / highest / latest rates, changes since the last quotation, and a chart. Reference only; it never changes how prices are calculated.
6. **Activity Logs** (admin): who created, edited, emailed or revised what. Entries cannot be changed or deleted from the app.

## Uploading a price list (Excel, CSV or PDF)

Master File → **Upload file** (or drag a file onto the rates box). Accepted: `.xlsx`, `.xls`, `.csv`, `.tsv`, `.txt`, `.pdf`. You get the **Check these prices** screen first; nothing is saved until you click **Save these rates**. Admin only.

- PDFs must contain real text (a PDF saved from Excel or Word does; a scan or phone photo does not). Compare the numbers with the PDF before saving; the amber note reminds you.
- The reader files for PDFs are in `public/vendor/pdfjs/`. Commit that folder to GitHub with the rest of the app.
- A price list written as a circular (a line saying *EFF. 16.11.2026*, then a table with refinery, product, basic, discount) is understood directly. Other layouts go through the advanced column mapper under **Show advanced options**.

## Optional settings (added in the security update)

Add these under **Environment Variables** in Render. None of them is required; the app works as before without them.

| Variable | What it does |
|---|---|
| `SITE_PASSWORD` | **Recommended.** Puts a password in front of the whole site (page, data and live sync). Browsers show their normal user name / password box once. Share the password only with your team. |
| `SITE_USER` | Optional. If set, the box must also have this exact user name. If empty, any user name is accepted and only the password is checked. |
| `CORS_ORIGINS` | Optional. Your site address, for example `https://refinecalc.onrender.com`. Other websites can then no longer call the data API from a browser. Separate several addresses with commas. |
| `EXTRA_STORAGE_KEYS` | Only needed if a future version of the page saves a new kind of data. Comma-separated key names the server should accept. |
| `BODY_LIMIT` | Largest save the server accepts. Default `15mb` (it was 50 MB). |
| `DB_SSL_STRICT` | Set to `true` to also verify Neon's security certificate. Off by default; turn it on, redeploy, and check that saving still works. |

See `CHANGES.md` for everything that changed and what was left alone.
