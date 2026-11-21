// crm.js - Customer Master, Quotation Records (immutable snapshots), Email sending, Activity log.
// Added as a separate module so server.js and the existing key/value sync stay exactly as they were.
// Everything lives in its own PostgreSQL tables (prefix crm_) inside the same Neon database.
'use strict';
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const CUSTOMER_TYPES = ['Industrial / End User', 'Dealer', 'Distributor', 'Trader', 'Contractor', 'Government / PSU', 'Other'];
const TZ_OFFSET = (process.env.APP_TIMEZONE_OFFSET || '+05:30').trim(); // India by default; used for "this month", dates and the QT-year
const TZ_MS = (() => { const m = /^([+-])(\d\d):(\d\d)$/.exec(TZ_OFFSET) || ['', '+', '05', '30']; return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000; })();

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; }
}

/* ------------------------------------------------------------------ small helpers */
const nowIso = () => new Date().toISOString();
const iso = v => (v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null);
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
const localParts = (d = new Date()) => { const x = new Date(d.getTime() + TZ_MS); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() }; };
const pad = (n, w) => String(n).padStart(w, '0');
const todayYmd = () => { const p = localParts(); return `${p.y}-${pad(p.m, 2)}-${pad(p.d, 2)}`; };
const monthStartIso = () => { const p = localParts(); return new Date(`${p.y}-${pad(p.m, 2)}-01T00:00:00${TZ_OFFSET}`).toISOString(); };
const dayStartIso = ymd => new Date(`${ymd}T00:00:00${TZ_OFFSET}`).toISOString();
const dayEndIso = ymd => new Date(new Date(`${ymd}T00:00:00${TZ_OFFSET}`).getTime() + 86400000).toISOString(); // exclusive
const isYmd = s => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
const str = (v, max = 500) => (v === null || v === undefined ? '' : String(v)).replace(/\u0000/g, '').trim().slice(0, max);
const oneLine = (v, max = 300) => str(v, max).replace(/[\r\n]+/g, ' ');
const isEmail = s => /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/.test(s);
const GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const likeTerm = s => '%' + String(s).toLowerCase().replace(/[\\%_]/g, m => '\\' + m) + '%';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 2) => (n === null || n === undefined || !isFinite(n) ? '-' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtDmy = ymd => (isYmd(ymd) ? `${ymd.slice(8, 10)}-${ymd.slice(5, 7)}-${ymd.slice(0, 4)}` : String(ymd || ''));

// Names are compared without punctuation and company suffixes, so "ABC Industries Pvt. Ltd." == "abc industries private limited"
function nameKey(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/).filter(w => w && !['pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'co', 'company', 'corp', 'corporation', 'the', 'and', 'm', 's'].includes(w)).join(' ');
}
function qb() { const params = []; return { params, p(v) { params.push(v); return '$' + params.length; } }; }

/* ------------------------------------------------------------------ schema */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS crm_counters (name VARCHAR(64) PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS crm_customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_person TEXT NOT NULL DEFAULT '',
  mobile TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  billing_address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  gst_no TEXT NOT NULL DEFAULT '',
  customer_type TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  name_key TEXT NOT NULL DEFAULT '',
  email_key TEXT NOT NULL DEFAULT '',
  gst_key TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  created_by_id TEXT, created_by_name TEXT, updated_by_id TEXT, updated_by_name TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_customers_gst_uq ON crm_customers (gst_key) WHERE gst_key <> '';
CREATE INDEX IF NOT EXISTS crm_customers_name_idx ON crm_customers (name_key);
CREATE INDEX IF NOT EXISTS crm_customers_email_idx ON crm_customers (email_key);

CREATE TABLE IF NOT EXISTS crm_quotations (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES crm_customers(id),
  customer_name TEXT NOT NULL,
  contact_person TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  quotation_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  revision_of TEXT REFERENCES crm_quotations(id),
  revision_no INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  remarks TEXT NOT NULL DEFAULT '',
  context JSONB,
  request_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  created_by_id TEXT, created_by_name TEXT,
  sent_at TIMESTAMPTZ, sent_by_id TEXT, sent_by_name TEXT,
  last_email_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_quotations_customer_idx ON crm_quotations (customer_id, created_at);
CREATE INDEX IF NOT EXISTS crm_quotations_date_idx ON crm_quotations (quotation_date);
CREATE INDEX IF NOT EXISTS crm_quotations_revision_idx ON crm_quotations (revision_of);

CREATE TABLE IF NOT EXISTS crm_quotation_items (
  id TEXT PRIMARY KEY,
  quotation_id TEXT NOT NULL REFERENCES crm_quotations(id),
  line_no INTEGER NOT NULL,
  product_id TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  supplier_id TEXT NOT NULL DEFAULT '',
  supplier_name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  quantity NUMERIC(14,3),
  rate NUMERIC(14,2) NOT NULL,
  gst_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  rate_incl_gst NUMERIC(14,2) NOT NULL,
  credit_days INTEGER,
  valid_till TEXT,
  rank_no INTEGER,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (quotation_id, line_no)
);
CREATE INDEX IF NOT EXISTS crm_items_quotation_idx ON crm_quotation_items (quotation_id);
CREATE INDEX IF NOT EXISTS crm_items_product_idx ON crm_quotation_items (product_id, product_name);

CREATE TABLE IF NOT EXISTS crm_email_logs (
  id TEXT PRIMARY KEY,
  quotation_id TEXT NOT NULL REFERENCES crm_quotations(id),
  kind TEXT NOT NULL,
  to_email TEXT NOT NULL,
  to_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT NOT NULL,
  attachment_name TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  attempted_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  sent_by_id TEXT, sent_by_name TEXT
);
CREATE INDEX IF NOT EXISTS crm_email_quotation_idx ON crm_email_logs (quotation_id, attempted_at);

CREATE TABLE IF NOT EXISTS crm_activity_log (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT, actor_name TEXT,
  customer_id TEXT, customer_name TEXT,
  quotation_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  details JSONB,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS crm_activity_time_idx ON crm_activity_log (created_at);
CREATE INDEX IF NOT EXISTS crm_activity_customer_idx ON crm_activity_log (customer_id);
CREATE INDEX IF NOT EXISTS crm_activity_quotation_idx ON crm_activity_log (quotation_id);

-- The audit trail and the quoted lines can never be edited, and nothing here can be deleted through the application.
CREATE OR REPLACE FUNCTION crm_protect_rows() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'crm: rows in % are permanent and cannot be % through the application', TG_TABLE_NAME, lower(TG_OP);
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS crm_items_frozen ON crm_quotation_items;
CREATE TRIGGER crm_items_frozen BEFORE UPDATE OR DELETE ON crm_quotation_items FOR EACH ROW EXECUTE FUNCTION crm_protect_rows();
DROP TRIGGER IF EXISTS crm_activity_frozen ON crm_activity_log;
CREATE TRIGGER crm_activity_frozen BEFORE UPDATE OR DELETE ON crm_activity_log FOR EACH ROW EXECUTE FUNCTION crm_protect_rows();
DROP TRIGGER IF EXISTS crm_quotations_nodelete ON crm_quotations;
CREATE TRIGGER crm_quotations_nodelete BEFORE DELETE ON crm_quotations FOR EACH ROW EXECUTE FUNCTION crm_protect_rows();
DROP TRIGGER IF EXISTS crm_customers_nodelete ON crm_customers;
CREATE TRIGGER crm_customers_nodelete BEFORE DELETE ON crm_customers FOR EACH ROW EXECUTE FUNCTION crm_protect_rows();
DROP TRIGGER IF EXISTS crm_email_nodelete ON crm_email_logs;
CREATE TRIGGER crm_email_nodelete BEFORE DELETE ON crm_email_logs FOR EACH ROW EXECUTE FUNCTION crm_protect_rows();
`;

/* ------------------------------------------------------------------ email: configuration, template, providers */
function emailConfig() {
  const provider = (process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
  const cfg = {
    provider,
    apiKey: (process.env.EMAIL_API_KEY || '').trim(),
    fromAddress: (process.env.EMAIL_FROM_ADDRESS || '').trim(),
    fromName: (process.env.EMAIL_FROM_NAME || '').trim(),
    replyTo: (process.env.EMAIL_REPLY_TO || '').trim(),
    bcc: (process.env.EMAIL_BCC || '').trim(),
    apiUrl: (process.env.EMAIL_API_URL || '').trim() || (provider === 'resend' ? 'https://api.resend.com/emails' : 'https://api.brevo.com/v3/smtp/email'),
    maxPerHour: Number(process.env.EMAIL_MAX_PER_HOUR) > 0 ? Number(process.env.EMAIL_MAX_PER_HOUR) : 60,
    timeoutMs: Number(process.env.EMAIL_TIMEOUT_MS) > 0 ? Number(process.env.EMAIL_TIMEOUT_MS) : 20000
  };
  cfg.enabled = ['brevo', 'resend'].includes(provider) && !!cfg.apiKey && isEmail(cfg.fromAddress);
  return cfg;
}

// Customer-facing content only: product, refinery/supplier, delivery town, rate, GST, credit. Internal cost data
// (basic price, freight, margin, landed cost) lives in the snapshot and is never put into an email.
function renderEmail({ quotationNo, quotationDate, customerName, contactPerson, message, items, sender, terms, validTill, preparedBy }) {
  const S = sender || {};
  const company = oneLine(S.companyName, 120) || 'Our Company';
  const noLabel = quotationNo || 'QT-(number assigned when sent)';
  const lines = String(message || '').replace(/\r/g, '').split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const showQty = items.some(i => i.quantity);
  const dear = contactPerson ? `Dear ${esc(contactPerson)},` : `Dear Sir / Madam,`;
  const rows = items.map((i, n) => `
      <tr>
        <td style="padding:10px 8px;border-bottom:1px solid #e3e9db;font-weight:700;color:#17633F;white-space:nowrap">Option ${n + 1}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e3e9db"><b>${esc(i.supplierName)}</b></td>
        <td style="padding:10px 8px;border-bottom:1px solid #e3e9db">${esc(i.productName)}${i.location ? `<div style="font-size:12px;color:#5f6b59">Delivered at ${esc(i.location)}</div>` : ''}</td>
        ${showQty ? `<td style="padding:10px 8px;border-bottom:1px solid #e3e9db;text-align:right;white-space:nowrap">${i.quantity ? esc(money(i.quantity, 2)) + ' ' + esc(i.unit) : '-'}</td>` : ''}
        <td style="padding:10px 8px;border-bottom:1px solid #e3e9db;text-align:right;white-space:nowrap"><b>&#8377;${esc(money(i.rate))}</b><div style="font-size:11px;color:#5f6b59">per ${esc(i.unit || 'unit')} excl. GST</div></td>
        <td style="padding:10px 8px;border-bottom:1px solid #e3e9db;text-align:right;white-space:nowrap">${esc(money(i.gstPct, i.gstPct % 1 ? 2 : 0))}%</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e3e9db;text-align:right;white-space:nowrap"><b>&#8377;${esc(money(i.rateInclGst))}</b><div style="font-size:11px;color:#5f6b59">per ${esc(i.unit || 'unit')} incl. GST</div></td>
        <td style="padding:10px 8px;border-bottom:1px solid #e3e9db;text-align:right;white-space:nowrap">${i.creditDays ? esc(i.creditDays) + ' days' : 'Advance'}</td>
      </tr>`).join('');
  const th = (t, right) => `<th style="padding:9px 8px;background:#17633F;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.04em;text-align:${right ? 'right' : 'left'};white-space:nowrap">${t}</th>`;
  const termList = (terms || []).map(t => oneLine(t, 400)).filter(Boolean).slice(0, 15);
  const contact = [S.phone && 'Ph: ' + oneLine(S.phone, 60), S.email && oneLine(S.email, 120), S.website && oneLine(S.website, 120)].filter(Boolean);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(noLabel)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f0;font-family:'Segoe UI',Arial,Helvetica,sans-serif;color:#1b2414">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f5f0"><tr><td align="center" style="padding:24px 10px">
<table role="presentation" width="680" cellspacing="0" cellpadding="0" style="max-width:680px;width:100%;background:#ffffff;border:1px solid #d5decb;border-radius:8px;overflow:hidden">
  <tr><td style="background:#17633F;padding:22px 28px">
    <div style="font-size:21px;font-weight:700;color:#ffffff">${esc(company)}</div>
    ${S.address ? `<div style="font-size:12px;color:#d9eadf;margin-top:4px">${esc(oneLine(S.address, 300))}</div>` : ''}
  </td></tr>
  <tr><td style="height:4px;background:#F2AE12;font-size:0;line-height:0">&nbsp;</td></tr>
  <tr><td style="padding:26px 28px 8px 28px;font-size:14px;line-height:1.55">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      <td style="font-size:12px;color:#5f6b59;text-transform:uppercase;letter-spacing:.06em">Quotation</td>
      <td align="right" style="font-size:12px;color:#5f6b59">Date: <b style="color:#1b2414">${esc(fmtDmy(quotationDate))}</b></td></tr>
      <tr><td style="font-size:18px;font-weight:700;color:#17633F;padding-top:2px">${esc(noLabel)}</td>
      <td align="right" style="font-size:12px;color:#5f6b59">To: <b style="color:#1b2414">${esc(customerName)}</b></td></tr></table>
    <p style="margin:20px 0 10px 0">${dear}</p>
    ${lines.map(l => `<p style="margin:0 0 10px 0">${esc(l).replace(/\n/g, '<br>')}</p>`).join('')}
  </td></tr>
  <tr><td style="padding:6px 20px 6px 20px">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px">
      <thead><tr>${th('Option')}${th('Supplier / Refinery')}${th('Product')}${showQty ? th('Quantity', true) : ''}${th('Rate (&#8377;) excl. GST', true)}${th('GST', true)}${th('Rate (&#8377;) incl. GST', true)}${th('Credit', true)}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="font-size:12px;color:#5f6b59;padding:8px 8px 0 8px">All amounts in Indian Rupees.${validTill ? ` Rates valid till <b style="color:#1b2414">${esc(fmtDmy(validTill))}</b>.` : ''}</div>
  </td></tr>
  ${termList.length ? `<tr><td style="padding:18px 28px 0 28px;font-size:13px;line-height:1.5"><div style="font-weight:700;color:#17633F;margin-bottom:4px">Terms and conditions</div><ol style="margin:0;padding-left:20px;color:#2b3523">${termList.map(t => `<li style="margin-bottom:3px">${esc(t)}</li>`).join('')}</ol></td></tr>` : ''}
  <tr><td style="padding:22px 28px 26px 28px;font-size:14px;line-height:1.5">
    <div>Warm regards,</div>
    <div style="margin-top:10px;font-weight:700">${esc(oneLine(preparedBy || S.signName, 80))}</div>
    ${S.signTitle ? `<div style="color:#5f6b59;font-size:13px">${esc(oneLine(S.signTitle, 100))}</div>` : ''}
    <div style="font-weight:700;color:#17633F;margin-top:2px">${esc(company)}</div>
    ${contact.length ? `<div style="color:#5f6b59;font-size:12px;margin-top:2px">${contact.map(esc).join(' &nbsp;|&nbsp; ')}</div>` : ''}
    ${S.gstin ? `<div style="color:#5f6b59;font-size:12px">GSTIN: ${esc(oneLine(S.gstin, 30))}</div>` : ''}
  </td></tr>
  <tr><td style="background:#f3f5f0;padding:12px 28px;font-size:11px;color:#7b8675;border-top:1px solid #e3e9db">This quotation was prepared for ${esc(customerName)}. Please reply to this email to confirm your order or to ask for any clarification.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    `${company}`, '', `Quotation ${noLabel}   Date: ${fmtDmy(quotationDate)}`, `To: ${customerName}`, '',
    contactPerson ? `Dear ${contactPerson},` : 'Dear Sir / Madam,', '', ...lines.flatMap(l => [l, '']),
    ...items.map((i, n) => `Option ${n + 1}: ${i.supplierName} | ${i.productName}${i.location ? ' | delivered at ' + i.location : ''}${i.quantity ? ' | qty ' + money(i.quantity, 2) + ' ' + i.unit : ''} | Rs. ${money(i.rate)} per ${i.unit || 'unit'} + GST ${money(i.gstPct, i.gstPct % 1 ? 2 : 0)}% = Rs. ${money(i.rateInclGst)} per ${i.unit || 'unit'} | ${i.creditDays ? i.creditDays + ' days credit' : 'advance'}`),
    '', validTill ? `Rates valid till ${fmtDmy(validTill)}.` : '',
    ...(termList.length ? ['', 'Terms and conditions:', ...termList.map((t, n) => `${n + 1}. ${t}`)] : []),
    '', 'Warm regards,', oneLine(preparedBy || S.signName, 80), S.signTitle ? oneLine(S.signTitle, 100) : '', company, contact.join(' | '), S.gstin ? 'GSTIN: ' + oneLine(S.gstin, 30) : ''
  ].filter((l, n, a) => !(l === '' && a[n - 1] === '')).join('\n');
  return { html, text };
}

function postJson(urlStr, headers, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch (e) { return reject(Object.assign(new Error('Email API address is invalid'), { notSent: true })); }
    const data = Buffer.from(JSON.stringify(bodyObj));
    const lib = u.protocol === 'http:' ? http : https;
    let done = false; const fin = (fn, v) => { if (!done) { done = true; fn(v); } };
    const req = lib.request({ method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Accept: 'application/json', ...headers } }, res => {
      const ch = []; res.on('data', d => ch.push(d));
      res.on('end', () => fin(resolve, { status: res.statusCode, text: Buffer.concat(ch).toString('utf8') }));
      res.on('error', e => fin(reject, Object.assign(e, { afterSend: true })));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); fin(reject, Object.assign(new Error('The email service did not answer in time'), { afterSend: true, timeout: true })); });
    req.on('error', e => fin(reject, ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(e.code) ? Object.assign(e, { notSent: true }) : Object.assign(e, { afterSend: true })));
    req.end(data);
  });
}

// Returns { outcome: 'sent'|'failed'|'unconfirmed', messageId, error }. 'sent' only when the provider answers 2xx WITH a message id.
async function deliver(cfg, { toEmail, toName, subject, html, text, attachment, idempotencyKey }) {
  const from = cfg.fromName ? { name: cfg.fromName, email: cfg.fromAddress } : { email: cfg.fromAddress };
  let url = cfg.apiUrl, headers, body;
  if (cfg.provider === 'brevo') {
    headers = { 'api-key': cfg.apiKey };
    body = { sender: from, to: [toName ? { email: toEmail, name: toName } : { email: toEmail }], subject, htmlContent: html, textContent: text, tags: ['quotation'] };
    if (cfg.replyTo) body.replyTo = { email: cfg.replyTo };
    if (cfg.bcc) body.bcc = [{ email: cfg.bcc }];
    if (attachment) body.attachment = [{ name: attachment.filename, content: attachment.contentBase64 }];
  } else {
    headers = { Authorization: 'Bearer ' + cfg.apiKey, 'Idempotency-Key': idempotencyKey };
    body = { from: cfg.fromName ? `${cfg.fromName.replace(/[<>"]/g, '')} <${cfg.fromAddress}>` : cfg.fromAddress, to: [toEmail], subject, html, text, tags: [{ name: 'type', value: 'quotation' }] };
    if (cfg.replyTo) body.reply_to = cfg.replyTo;
    if (cfg.bcc) body.bcc = [cfg.bcc];
    if (attachment) body.attachments = [{ filename: attachment.filename, content: attachment.contentBase64 }];
  }
  let r;
  try { r = await postJson(url, headers, body, cfg.timeoutMs); }
  catch (e) {
    if (e.notSent) return { outcome: 'failed', error: 'Could not reach the email service (' + (e.code || e.message) + '). Nothing was sent.' };
    return { outcome: 'unconfirmed', error: (e.timeout ? 'The email service did not answer in time.' : 'The connection to the email service broke (' + (e.code || e.message) + ').') + ' It is not known whether the email was delivered. Check the mailbox / email service dashboard before sending again.' };
  }
  let j = null; try { j = JSON.parse(r.text); } catch (_) {}
  if (r.status >= 200 && r.status < 300) {
    const id = j && (j.messageId || j.id);
    if (id) return { outcome: 'sent', messageId: String(id).slice(0, 200) };
    return { outcome: 'unconfirmed', error: 'The email service answered OK but gave no message id, so delivery could not be confirmed. Check the email service dashboard before sending again.' };
  }
  const msg = (j && (j.message || j.error || (j.errors && JSON.stringify(j.errors)))) || r.text.slice(0, 200) || 'no details';
  return { outcome: 'failed', error: `Email service refused it (HTTP ${r.status}): ${String(msg).slice(0, 300)}` };
}

/* ------------------------------------------------------------------ the module */
function createCrm({ pool, siteProtected }) {
  let ready = false;
  const log = (...a) => console.log('[crm]', ...a);

  async function tx(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }

  async function init() {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(748201)'); // two servers starting at once (a Render deploy) cannot collide
      await c.query(SCHEMA_SQL);
      await c.query('COMMIT');
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
    ready = true;
    log('customer / quotation tables ready');
  }

  async function nextCounter(c, name) {
    const r = await c.query('INSERT INTO crm_counters (name, value) VALUES ($1, 1) ON CONFLICT (name) DO UPDATE SET value = crm_counters.value + 1 RETURNING value', [name]);
    return Number(r.rows[0].value);
  }

  async function addActivity(db, a) {
    await db.query(
      'INSERT INTO crm_activity_log (id, created_at, action, actor_id, actor_name, customer_id, customer_name, quotation_id, summary, details, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      ['ACT-' + crypto.randomUUID(), nowIso(), a.action, a.actor?.id || '', a.actor?.name || '', a.customerId || null, a.customerName || null, a.quotationId || null, oneLine(a.summary, 400), JSON.stringify(a.details || {}), a.ip || '']);
  }

  const actorOf = body => ({ id: oneLine(body?.actor?.id, 80), name: oneLine(body?.actor?.name, 120) || 'Unknown user' });

  /* ---------- customers ---------- */
  const customerOut = r => ({
    id: r.id, name: r.name, contactPerson: r.contact_person, mobile: r.mobile, email: r.email, billingAddress: r.billing_address,
    city: r.city, state: r.state, gstNo: r.gst_no, customerType: r.customer_type, notes: r.notes, status: r.status, version: Number(r.version),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), createdByName: r.created_by_name || '', updatedByName: r.updated_by_name || '',
    ...(r.quotation_count !== undefined ? { quotationCount: Number(r.quotation_count), sentCount: Number(r.sent_count), lastQuotedAt: iso(r.last_quoted_at) } : {})
  });
  const CUSTOMER_SELECT = `SELECT c.*, COALESCE(s.qn, 0) AS quotation_count, COALESCE(s.sn, 0) AS sent_count, s.last_at AS last_quoted_at
    FROM crm_customers c LEFT JOIN (SELECT customer_id, COUNT(*) AS qn, COUNT(sent_at) AS sn, MAX(created_at) AS last_at FROM crm_quotations GROUP BY customer_id) s ON s.customer_id = c.id`;

  function cleanCustomer(input, { partial = false } = {}) {
    const o = input || {}; const out = {};
    const take = (k, max, fn) => { if (!partial || o[k] !== undefined) out[k] = fn ? fn(o[k]) : oneLine(o[k], max); };
    take('name', 160); take('contactPerson', 120); take('city', 80); take('state', 80); take('customerType', 60);
    take('mobile', 30, v => oneLine(v, 30).replace(/[^0-9+\-\s()]/g, ''));
    take('email', 160, v => oneLine(v, 160).toLowerCase());
    take('billingAddress', 600, v => str(v, 600));
    take('notes', 2000, v => str(v, 2000));
    take('gstNo', 20, v => oneLine(v, 20).toUpperCase().replace(/\s+/g, ''));
    if ((!partial || out.name !== undefined) && out.name.length < 2) throw new HttpError(400, 'Customer / company name is required (at least 2 letters).');
    if (out.email && !isEmail(out.email)) throw new HttpError(400, 'That email address does not look right.');
    if (out.gstNo && !GST_RE.test(out.gstNo)) throw new HttpError(400, 'GST number must be 15 characters like 24ABCDE1234F1Z5 (or leave it empty).');
    if (out.customerType && !CUSTOMER_TYPES.includes(out.customerType)) out.customerType = 'Other';
    return out;
  }

  // only = which fields to compare; when editing, only the fields that actually changed are checked, so a customer that was
  // knowingly saved next to a similar one is not nagged again every time an unrelated field is edited
  async function findDuplicates(db, c, excludeId, only) {
    const q = qb(); const conds = [];
    const want = k => !only || only[k];
    const nk = want('name') ? nameKey(c.name) : '';
    if (c.gstNo && want('gst')) conds.push(`gst_key = ${q.p(c.gstNo)}`);
    if (c.email && want('email')) conds.push(`email_key = ${q.p(c.email)}`);
    if (nk) {
      const a = q.p(nk);
      conds.push(c.city ? `(name_key = ${a} AND (LOWER(city) = ${q.p(String(c.city).toLowerCase())} OR city = ''))` : `name_key = ${a}`);
    }
    if (!conds.length) return [];
    let sql = `SELECT * FROM crm_customers WHERE (${conds.join(' OR ')})`;
    if (excludeId) sql += ` AND id <> ${q.p(excludeId)}`;
    const r = await db.query(sql + ' LIMIT 5', q.params);
    return r.rows.map(row => ({ ...customerOut(row), matchedOn: [c.gstNo && row.gst_key === c.gstNo && 'GST number', c.email && row.email_key === c.email && 'email', nk && row.name_key === nk && 'name'].filter(Boolean) }));
  }

  async function createCustomer(body, ip) {
    const c = cleanCustomer(body.customer);
    const actor = actorOf(body);
    const dups = await findDuplicates(pool, c, null);
    const hard = dups.find(d => d.matchedOn.includes('GST number'));
    if (hard) throw new HttpError(409, `A customer with GST number ${c.gstNo} already exists: ${hard.name}.`, { code: 'duplicate_gst', duplicates: dups });
    if (dups.length && !body.force) throw new HttpError(409, 'A similar customer already exists. Use that one, or confirm to create a new record anyway.', { code: 'possible_duplicate', duplicates: dups, canForce: true });
    const row = await tx(async db => {
      const n = await nextCounter(db, 'CUS');
      const id = 'CUS-' + pad(n, 5); const t = nowIso();
      await db.query(
        `INSERT INTO crm_customers (id, name, contact_person, mobile, email, billing_address, city, state, gst_no, customer_type, notes, status, name_key, email_key, gst_key, version, created_at, updated_at, created_by_id, created_by_name, updated_by_id, updated_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13,$14,1,$15,$15,$16,$17,$16,$17)`,
        [id, c.name, c.contactPerson, c.mobile, c.email, c.billingAddress, c.city, c.state, c.gstNo, c.customerType, c.notes, nameKey(c.name), c.email, c.gstNo, t, actor.id, actor.name]);
      await addActivity(db, { action: 'customer.created', actor, customerId: id, customerName: c.name, summary: `Customer ${c.name} created`, details: { customer: c, forcedDespiteDuplicates: !!(dups.length && body.force) }, ip });
      return (await db.query(CUSTOMER_SELECT + ' WHERE c.id = $1', [id])).rows[0];
    });
    return customerOut(row);
  }

  const FIELD_MAP = { name: 'name', contactPerson: 'contact_person', mobile: 'mobile', email: 'email', billingAddress: 'billing_address', city: 'city', state: 'state', gstNo: 'gst_no', customerType: 'customer_type', notes: 'notes' };

  async function updateCustomer(id, body, ip) {
    const ch = cleanCustomer(body.changes, { partial: true });
    const actor = actorOf(body);
    return tx(async db => {
      const cur = (await db.query('SELECT * FROM crm_customers WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw new HttpError(404, 'Customer not found.');
      if (body.version !== undefined && Number(body.version) !== Number(cur.version)) throw new HttpError(409, 'Someone else changed this customer while you were editing. Reload and try again.', { code: 'version_conflict', current: customerOut(cur) });
      const diff = {}; const merged = customerOut(cur);
      for (const k of Object.keys(FIELD_MAP)) {
        if (ch[k] === undefined) continue;
        if (String(ch[k]) !== String(cur[FIELD_MAP[k]])) { diff[k] = { from: cur[FIELD_MAP[k]], to: ch[k] }; merged[k] = ch[k]; }
      }
      if (!Object.keys(diff).length) return { customer: customerOut((await db.query(CUSTOMER_SELECT + ' WHERE c.id = $1', [id])).rows[0]), unchanged: true };
      if (diff.name || diff.email || diff.gstNo || diff.city) {
        const dups = await findDuplicates(db, merged, id, { name: !!(diff.name || diff.city), email: !!diff.email, gst: !!diff.gstNo });
        const hard = dups.find(d => d.matchedOn.includes('GST number'));
        if (hard) throw new HttpError(409, `Another customer already uses GST number ${merged.gstNo}: ${hard.name}.`, { code: 'duplicate_gst', duplicates: dups });
        if (dups.length && !body.force) throw new HttpError(409, 'This would make the customer look like an existing one. Confirm to save anyway.', { code: 'possible_duplicate', duplicates: dups, canForce: true });
      }
      const t = nowIso();
      await db.query(
        `UPDATE crm_customers SET name=$2, contact_person=$3, mobile=$4, email=$5, billing_address=$6, city=$7, state=$8, gst_no=$9, customer_type=$10, notes=$11,
           name_key=$12, email_key=$13, gst_key=$14, version=version+1, updated_at=$15, updated_by_id=$16, updated_by_name=$17 WHERE id=$1`,
        [id, merged.name, merged.contactPerson, merged.mobile, merged.email, merged.billingAddress, merged.city, merged.state, merged.gstNo, merged.customerType, merged.notes, nameKey(merged.name), merged.email, merged.gstNo, t, actor.id, actor.name]);
      await addActivity(db, { action: 'customer.updated', actor, customerId: id, customerName: merged.name, summary: `Customer ${merged.name} updated (${Object.keys(diff).join(', ')})`, details: { changes: diff }, ip });
      return { customer: customerOut((await db.query(CUSTOMER_SELECT + ' WHERE c.id = $1', [id])).rows[0]) };
    });
  }

  async function setCustomerStatus(id, status, body, ip) {
    const actor = actorOf(body);
    return tx(async db => {
      const cur = (await db.query('SELECT * FROM crm_customers WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw new HttpError(404, 'Customer not found.');
      if (cur.status !== status) {
        await db.query('UPDATE crm_customers SET status=$2, version=version+1, updated_at=$3, updated_by_id=$4, updated_by_name=$5 WHERE id=$1', [id, status, nowIso(), actor.id, actor.name]);
        await addActivity(db, { action: status === 'archived' ? 'customer.archived' : 'customer.restored', actor, customerId: id, customerName: cur.name, summary: `Customer ${cur.name} ${status === 'archived' ? 'archived' : 'restored'}`, ip });
      }
      return customerOut((await db.query(CUSTOMER_SELECT + ' WHERE c.id = $1', [id])).rows[0]);
    });
  }

  async function listCustomers(query) {
    const q = qb(); const w = [];
    const status = ['active', 'archived'].includes(query.status) ? query.status : null;
    if (status) w.push(`c.status = ${q.p(status)}`);
    const term = oneLine(query.q, 100).toLowerCase();
    if (term) {
      const like = q.p(likeTerm(term)); const digits = term.replace(/\D/g, '');
      const parts = [`LOWER(c.name) LIKE ${like}`, `LOWER(c.contact_person) LIKE ${like}`, `LOWER(c.email) LIKE ${like}`, `LOWER(c.city) LIKE ${like}`, `LOWER(c.gst_no) LIKE ${like}`, `LOWER(c.id) LIKE ${like}`, `LOWER(c.mobile) LIKE ${like}`];
      if (digits.length >= 3) parts.push(`REGEXP_REPLACE(c.mobile, '[^0-9]', '', 'g') LIKE ${q.p('%' + digits + '%')}`);
      w.push('(' + parts.join(' OR ') + ')');
    }
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 500, 1), 2000);
    const r = await pool.query(`${CUSTOMER_SELECT} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY LOWER(c.name), c.id LIMIT ${q.p(limit)}`, q.params);
    return r.rows.map(customerOut);
  }

  /* ---------- quotations ---------- */
  const itemOut = r => ({
    lineNo: Number(r.line_no), productId: r.product_id, productName: r.product_name, unit: r.unit, supplierId: r.supplier_id, supplierName: r.supplier_name,
    location: r.location, quantity: num(r.quantity), rate: num(r.rate), gstPct: num(r.gst_pct), rateInclGst: num(r.rate_incl_gst),
    creditDays: r.credit_days === null ? null : Number(r.credit_days), validTill: r.valid_till || '', rankNo: r.rank_no === null ? null : Number(r.rank_no), snapshot: r.snapshot
  });
  const emailOut = (r, withBody) => ({
    id: r.id, quotationId: r.quotation_id, kind: r.kind, toEmail: r.to_email, toName: r.to_name, subject: r.subject, status: r.status, error: r.error,
    providerMessageId: r.provider_message_id, provider: r.provider, attachmentName: r.attachment_name, attemptedAt: iso(r.attempted_at), completedAt: iso(r.completed_at),
    sentBy: { id: r.sent_by_id || '', name: r.sent_by_name || '' }, ...(withBody ? { bodyHtml: r.body_html, bodyText: r.body_text } : {})
  });
  const quotationOut = r => ({
    id: r.id, customerId: r.customer_id, customerName: r.customer_name, contactPerson: r.contact_person, email: r.email, quotationDate: r.quotation_date,
    status: r.status, revisionOf: r.revision_of, revisionNo: Number(r.revision_no), supersededBy: r.superseded_by || null, subject: r.subject, message: r.message, remarks: r.remarks,
    context: r.context, createdAt: iso(r.created_at), createdBy: { id: r.created_by_id || '', name: r.created_by_name || '' },
    sentAt: iso(r.sent_at), sentBy: { id: r.sent_by_id || '', name: r.sent_by_name || '' }, lastEmailId: r.last_email_id
  });
  const QSELECT = 'SELECT q.*, (SELECT r.id FROM crm_quotations r WHERE r.revision_of = q.id ORDER BY r.created_at DESC LIMIT 1) AS superseded_by FROM crm_quotations q';

  async function attachDetails(db, rows, { emails = true } = {}) {
    const list = rows.map(quotationOut); if (!list.length) return list;
    const ids = list.map(q => q.id); const q = qb(); const ph = ids.map(i => q.p(i)).join(',');
    const items = (await db.query(`SELECT * FROM crm_quotation_items WHERE quotation_id IN (${ph}) ORDER BY quotation_id, line_no`, q.params)).rows;
    const by = {}; items.forEach(i => (by[i.quotation_id] = by[i.quotation_id] || []).push(itemOut(i)));
    const q2 = qb(); const ph2 = ids.map(i => q2.p(i)).join(',');
    const mails = (await db.query(`SELECT id, quotation_id, kind, to_email, to_name, subject, status, error, provider_message_id, provider, attachment_name, attempted_at, completed_at, sent_by_id, sent_by_name, '' AS body_html, '' AS body_text FROM crm_email_logs WHERE quotation_id IN (${ph2}) ORDER BY attempted_at`, q2.params)).rows;
    const bm = {}; mails.forEach(m => (bm[m.quotation_id] = bm[m.quotation_id] || []).push(emailOut(m)));
    list.forEach(x => { x.items = by[x.id] || []; x.emails = bm[x.id] || []; x.lastEmail = x.emails[x.emails.length - 1] || null; });
    return list;
  }

  async function getQuotation(db, id) {
    const r = (await db.query(QSELECT + ' WHERE q.id = $1', [id])).rows[0];
    if (!r) return null;
    return (await attachDetails(db, [r]))[0];
  }

  function cleanItems(arr) {
    if (!Array.isArray(arr) || !arr.length) throw new HttpError(400, 'Pick at least one quotation option.');
    if (arr.length > 10) throw new HttpError(400, 'A quotation can hold at most 10 options.');
    return arr.map((it, n) => {
      const o = it || {};
      const rate = Number(o.rate); const gst = o.gstPct === undefined || o.gstPct === null || o.gstPct === '' ? 0 : Number(o.gstPct);
      if (!isFinite(rate) || rate < 0) throw new HttpError(400, `Option ${n + 1}: the rate is not a valid number.`);
      if (!isFinite(gst) || gst < 0 || gst > 100) throw new HttpError(400, `Option ${n + 1}: GST % is not valid.`);
      const r2 = Math.round(rate * 100) / 100;
      const incl = o.rateInclGst !== undefined && o.rateInclGst !== null && o.rateInclGst !== '' && isFinite(Number(o.rateInclGst)) ? Math.round(Number(o.rateInclGst) * 100) / 100 : Math.round(r2 * (1 + gst / 100) * 100) / 100;
      const supplierName = oneLine(o.supplierName, 160), productName = oneLine(o.productName, 160);
      if (!supplierName || !productName) throw new HttpError(400, `Option ${n + 1}: supplier / refinery and product names are required.`);
      const snap = o.snapshot && typeof o.snapshot === 'object' ? o.snapshot : {};
      const snapStr = JSON.stringify(snap); if (snapStr.length > 20000) throw new HttpError(400, `Option ${n + 1}: snapshot is too large.`);
      const qty = o.quantity === null || o.quantity === undefined || o.quantity === '' ? null : Number(o.quantity);
      return {
        lineNo: n + 1, productId: oneLine(o.productId, 80), productName, unit: oneLine(o.unit, 20), supplierId: oneLine(o.supplierId, 120), supplierName,
        location: oneLine(o.location, 120), quantity: qty !== null && isFinite(qty) && qty >= 0 ? qty : null, rate: r2, gstPct: gst, rateInclGst: incl,
        creditDays: o.creditDays === null || o.creditDays === undefined || o.creditDays === '' || !isFinite(Number(o.creditDays)) ? null : Math.max(0, Math.round(Number(o.creditDays))),
        validTill: isYmd(o.validTill) ? o.validTill : '', rankNo: Number.isInteger(o.rankNo) ? o.rankNo : null, snapStr
      };
    });
  }

  async function createQuotation(body, ip) {
    const actor = actorOf(body);
    const requestId = oneLine(body.requestId, 100);
    if (requestId) { // a retried request returns the record that already exists instead of creating a second one
      const ex = (await pool.query(QSELECT + ' WHERE q.request_id = $1', [requestId])).rows[0];
      if (ex) return { quotation: (await attachDetails(pool, [ex]))[0], duplicate: true };
    }
    const items = cleanItems(body.items);
    const qdate = isYmd(body.quotationDate) ? body.quotationDate : todayYmd();
    const ctxIn = body.context && typeof body.context === 'object' ? body.context : {};
    if (JSON.stringify(ctxIn).length > 10000) throw new HttpError(400, 'Quotation context is too large.');
    let id;
    try {
      id = await tx(async db => {
        const cust = (await db.query('SELECT * FROM crm_customers WHERE id = $1 FOR SHARE', [oneLine(body.customerId, 40)])).rows[0];
        if (!cust) throw new HttpError(404, 'Pick a customer from the Customer Master first.');
        if (cust.status === 'archived') throw new HttpError(409, `${cust.name} is archived. Restore the customer first.`);
        let parent = null, revNo = 0;
        const revOf = oneLine(body.revisionOf, 40);
        if (revOf) {
          parent = (await db.query('SELECT * FROM crm_quotations WHERE id = $1 FOR UPDATE', [revOf])).rows[0];
          if (!parent) throw new HttpError(404, 'The quotation you are revising was not found.');
          if (parent.customer_id !== cust.id) throw new HttpError(409, 'A revision must be for the same customer.');
          const nxt = (await db.query('SELECT id FROM crm_quotations WHERE revision_of = $1 LIMIT 1', [revOf])).rows[0];
          if (nxt) throw new HttpError(409, `${revOf} was already revised as ${nxt.id}. Revise that one instead.`, { code: 'already_revised', supersededBy: nxt.id });
          revNo = Number(parent.revision_no) + 1;
        }
        // the customer's full details as they were when the quotation was made (used to rebuild the PDF later exactly as it was)
        const ctx = JSON.stringify({ ...ctxIn, customerSnapshot: { name: cust.name, contactPerson: cust.contact_person, mobile: cust.mobile, email: cust.email, billingAddress: cust.billing_address, city: cust.city, state: cust.state, gstNo: cust.gst_no, customerType: cust.customer_type } });
        const year = localParts().y;
        const n = await nextCounter(db, 'QT-' + year);
        const qid = `QT-${year}-${pad(n, 5)}`; const t = nowIso();
        await db.query(
          `INSERT INTO crm_quotations (id, customer_id, customer_name, contact_person, email, quotation_date, status, revision_of, revision_no, subject, message, remarks, context, request_id, created_at, created_by_id, created_by_name, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$14)`,
          [qid, cust.id, cust.name, cust.contact_person, cust.email, qdate, parent ? parent.id : null, revNo, oneLine(body.subject, 300), str(body.message, 5000), str(body.remarks, 2000), ctx, requestId || null, t, actor.id, actor.name]);
        for (const it of items) {
          await db.query(
            `INSERT INTO crm_quotation_items (id, quotation_id, line_no, product_id, product_name, unit, supplier_id, supplier_name, location, quantity, rate, gst_pct, rate_incl_gst, credit_days, valid_till, rank_no, snapshot, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [qid + '-' + it.lineNo, qid, it.lineNo, it.productId, it.productName, it.unit, it.supplierId, it.supplierName, it.location, it.quantity, it.rate, it.gstPct, it.rateInclGst, it.creditDays, it.validTill, it.rankNo, it.snapStr, t]);
        }
        const summary = items.map(i => `${i.supplierName} @ ${i.rate}`).join('; ');
        await addActivity(db, { action: 'quotation.generated', actor, customerId: cust.id, customerName: cust.name, quotationId: qid, summary: `Quotation ${qid} created for ${cust.name} (${items.length} option${items.length > 1 ? 's' : ''})`, details: { product: items[0].productName, options: items.map(i => ({ supplier: i.supplierName, rate: i.rate })), summary }, ip });
        if (parent) {
          await db.query("UPDATE crm_quotations SET status = 'revised', updated_at = $2 WHERE id = $1", [parent.id, t]);
          await addActivity(db, { action: 'quotation.revised', actor, customerId: cust.id, customerName: cust.name, quotationId: qid, summary: `Quotation ${qid} revises ${parent.id}`, details: { revisionOf: parent.id, previousStatus: parent.status }, ip });
        }
        return qid;
      });
    } catch (e) {
      if (e.code === '23505' && requestId) { // two identical requests raced: hand back the winner
        const ex = (await pool.query(QSELECT + ' WHERE q.request_id = $1', [requestId])).rows[0];
        if (ex) return { quotation: (await attachDetails(pool, [ex]))[0], duplicate: true };
      }
      throw e;
    }
    return { quotation: await getQuotation(pool, id) };
  }

  async function patchQuotation(id, body, ip) {
    const actor = actorOf(body);
    return tx(async db => {
      const cur = (await db.query('SELECT * FROM crm_quotations WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw new HttpError(404, 'Quotation not found.');
      const diff = {}; const set = {};
      if (body.remarks !== undefined) { const v = str(body.remarks, 2000); if (v !== cur.remarks) { diff.remarks = { from: cur.remarks, to: v }; set.remarks = v; } }
      if (body.subject !== undefined || body.message !== undefined) {
        if (!['draft', 'failed'].includes(cur.status)) throw new HttpError(409, 'The subject and message of a quotation that was already sent are part of its record and cannot be changed. Use Revise instead.');
        if (body.subject !== undefined) { const v = oneLine(body.subject, 300); if (v !== cur.subject) { diff.subject = { from: cur.subject, to: v }; set.subject = v; } }
        if (body.message !== undefined) { const v = str(body.message, 5000); if (v !== cur.message) { diff.message = { from: cur.message, to: v }; set.message = v; } }
      }
      if (Object.keys(set).length) {
        const q = qb(); const sets = Object.keys(set).map(k => `${k} = ${q.p(set[k])}`); sets.push(`updated_at = ${q.p(nowIso())}`);
        await db.query(`UPDATE crm_quotations SET ${sets.join(', ')} WHERE id = ${q.p(id)}`, q.params);
        await addActivity(db, { action: 'quotation.modified', actor, customerId: cur.customer_id, customerName: cur.customer_name, quotationId: id, summary: `Quotation ${id} modified (${Object.keys(diff).join(', ')})`, details: { changes: diff }, ip });
      }
      return { quotation: await getQuotation(db, id), unchanged: !Object.keys(set).length };
    });
  }

  async function listQuotations(query) {
    const q = qb(); const w = [];
    if (query.customerId) w.push(`q.customer_id = ${q.p(oneLine(query.customerId, 40))}`);
    if (isYmd(query.from)) w.push(`q.quotation_date >= ${q.p(query.from)}`);
    if (isYmd(query.to)) w.push(`q.quotation_date <= ${q.p(query.to)}`);
    if (['draft', 'sent', 'failed', 'revised'].includes(query.status)) w.push(`q.status = ${q.p(query.status)}`);
    if (query.product) w.push(`EXISTS (SELECT 1 FROM crm_quotation_items i WHERE i.quotation_id = q.id AND (LOWER(i.product_name) LIKE ${q.p(likeTerm(oneLine(query.product, 100)))}))`);
    if (query.supplier) w.push(`EXISTS (SELECT 1 FROM crm_quotation_items i WHERE i.quotation_id = q.id AND (LOWER(i.supplier_name) LIKE ${q.p(likeTerm(oneLine(query.supplier, 100)))}))`);
    if (query.employee) w.push(`LOWER(COALESCE(NULLIF(q.sent_by_name, ''), q.created_by_name)) = ${q.p(oneLine(query.employee, 120).toLowerCase())}`);
    if (query.q) { const l = q.p(likeTerm(oneLine(query.q, 100))); w.push(`(LOWER(q.id) LIKE ${l} OR LOWER(q.customer_name) LIKE ${l} OR LOWER(q.remarks) LIKE ${l})`); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const total = Number((await pool.query(`SELECT COUNT(*) AS n FROM crm_quotations q ${where}`, [...q.params])).rows[0].n);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 200, 1), 1000), offset = Math.max(parseInt(query.offset, 10) || 0, 0);
    const rows = (await pool.query(`${QSELECT} ${where} ORDER BY q.created_at DESC, q.id DESC LIMIT ${q.p(limit)} OFFSET ${q.p(offset)}`, q.params)).rows;
    return { total, quotations: await attachDetails(pool, rows) };
  }

  async function filterValues(customerId) {
    const q = qb(); const w = customerId ? `WHERE q.customer_id = ${q.p(customerId)}` : '';
    const prod = (await pool.query(`SELECT DISTINCT i.product_name AS v FROM crm_quotation_items i JOIN crm_quotations q ON q.id = i.quotation_id ${w} ORDER BY 1`, q.params)).rows.map(r => r.v);
    const sup = (await pool.query(`SELECT DISTINCT i.supplier_name AS v FROM crm_quotation_items i JOIN crm_quotations q ON q.id = i.quotation_id ${w} ORDER BY 1`, q.params)).rows.map(r => r.v);
    const emp = (await pool.query(`SELECT DISTINCT COALESCE(NULLIF(q.sent_by_name, ''), q.created_by_name) AS v FROM crm_quotations q ${w} ORDER BY 1`, q.params)).rows.map(r => r.v).filter(Boolean);
    return { products: prod, suppliers: sup, employees: emp };
  }

  /* ---------- sending ---------- */
  function emailBlocked(cfg) {
    if (!cfg.enabled) return 'Email sending is not set up yet. Add EMAIL_PROVIDER, EMAIL_API_KEY and EMAIL_FROM_ADDRESS in Render > Environment (see README).';
    if (!siteProtected) return 'For safety, email sending stays off until SITE_PASSWORD is set in Render > Environment (otherwise anyone who finds the address could send email from your account).';
    return '';
  }

  function buildEmailFor(q, items, cust, body, actor) {
    const subjectRaw = oneLine(body.subject, 300) || oneLine(q.subject, 300) || `Quotation ${q.id}`;
    const subject = subjectRaw.replace(/\{QTNO\}/g, q.id);
    const message = body.message !== undefined ? str(body.message, 5000) : q.message;
    const terms = Array.isArray(body.terms) ? body.terms.slice(0, 15) : [];
    const r = renderEmail({
      quotationNo: q.id, quotationDate: q.quotationDate, customerName: q.customerName, contactPerson: cust.contact_person, message, items, sender: body.sender, terms,
      validTill: isYmd(body.validTill) ? body.validTill : items.find(i => i.validTill)?.validTill || '', preparedBy: actor.name !== 'Unknown user' ? actor.name : ''
    });
    return { subject, message, ...r };
  }

  async function sendQuotation(id, body, ip) {
    const cfg = emailConfig();
    const blocked = emailBlocked(cfg);
    if (blocked) throw new HttpError(503, blocked, { code: 'email_not_configured' });
    const actor = actorOf(body);
    const key = oneLine(body.idempotencyKey, 100);
    if (key.length < 8) throw new HttpError(400, 'Missing send reference. Reload the page and try again.');

    // 1) same request seen before? return what happened, never send twice
    const prior = (await pool.query('SELECT * FROM crm_email_logs WHERE idempotency_key = $1', [key])).rows[0];
    if (prior) return settledResult(prior);

    let att = null;
    if (body.attachment) {
      const b64 = String(body.attachment.contentBase64 || '').replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length > 6 * 1024 * 1024) throw new HttpError(400, 'The PDF attachment is not valid or is too large.');
      if (Buffer.from(b64.slice(0, 16), 'base64').subarray(0, 4).toString() !== '%PDF') throw new HttpError(400, 'The attachment is not a PDF.');
      att = { filename: oneLine(body.attachment.filename, 120).replace(/[^\w.\- ()]+/g, '_') || `${id}.pdf`, contentBase64: b64 };
    }

    // 2) reserve the attempt (row locked so two different clicks cannot both send)
    let mail, q, cust, items;
    await tx(async db => {
      const row = (await db.query('SELECT * FROM crm_quotations WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!row) throw new HttpError(404, 'Quotation not found.');
      if (row.status === 'revised') throw new HttpError(409, `${id} was revised, so it can no longer be sent. Send the newer revision instead.`, { code: 'revised' });
      cust = (await db.query('SELECT * FROM crm_customers WHERE id = $1', [row.customer_id])).rows[0];
      if (!cust) throw new HttpError(404, 'Customer not found.');
      if (cust.status === 'archived') throw new HttpError(409, `${cust.name} is archived. Restore the customer first.`);
      if (!isEmail(cust.email)) throw new HttpError(409, `${cust.name} has no valid email address. Add it in the Customer Master first.`, { code: 'no_email' });
      const busy = (await db.query("SELECT id FROM crm_email_logs WHERE quotation_id = $1 AND status = 'sending' AND attempted_at > $2 LIMIT 1", [id, new Date(Date.now() - 120000).toISOString()])).rows[0];
      if (busy) throw new HttpError(409, 'An email for this quotation is being sent right now. Wait a moment and check the history.', { code: 'send_in_progress' });
      const hourAgo = new Date(Date.now() - 3600000).toISOString();
      const used = Number((await db.query('SELECT COUNT(*) AS n FROM crm_email_logs WHERE attempted_at > $1', [hourAgo])).rows[0].n);
      if (used >= cfg.maxPerHour) throw new HttpError(429, `Email limit reached (${cfg.maxPerHour} per hour). Try again later.`);
      q = (await attachDetails(db, [(await db.query(QSELECT + ' WHERE q.id = $1', [id])).rows[0]]))[0];
      items = q.items;
      const built = buildEmailFor(q, items, cust, body, actor);
      const priorSend = Number((await db.query("SELECT COUNT(*) AS n FROM crm_email_logs WHERE quotation_id = $1 AND status = 'sent'", [id])).rows[0].n);
      mail = { id: 'EML-' + crypto.randomUUID(), kind: priorSend ? 'resend' : 'send', toEmail: cust.email, toName: cust.contact_person || cust.name, ...built };
      const ins = await db.query(
        `INSERT INTO crm_email_logs (id, quotation_id, kind, to_email, to_name, subject, body_html, body_text, attachment_name, provider, status, idempotency_key, attempted_at, sent_by_id, sent_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sending',$11,$12,$13,$14) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [mail.id, id, mail.kind, mail.toEmail, mail.toName, mail.subject, mail.html, mail.text, att ? att.filename : '', cfg.provider, key, nowIso(), actor.id, actor.name]);
      if (!ins.rows.length) throw new HttpError(409, 'This send was already started.', { code: 'send_in_progress' });
    });

    // 3) talk to the email service (no database lock is held while we wait)
    let res;
    try { res = await deliver(cfg, { toEmail: mail.toEmail, toName: mail.toName, subject: mail.subject, html: mail.html, text: mail.text, attachment: att, idempotencyKey: key }); }
    catch (e) { res = { outcome: 'unconfirmed', error: 'Unexpected error while sending: ' + String(e.message).slice(0, 200) + '. Check the mailbox before sending again.' }; }

    // 4) record exactly what happened
    const t = nowIso(); const finalStatus = res.outcome;
    await tx(async db => {
      await db.query('UPDATE crm_email_logs SET status=$2, error=$3, provider_message_id=$4, completed_at=$5 WHERE id=$1', [mail.id, finalStatus, res.error || '', res.messageId || '', t]);
      const cur = (await db.query('SELECT * FROM crm_quotations WHERE id = $1 FOR UPDATE', [id])).rows[0];
      const firstSuccess = finalStatus === 'sent' && !cur.sent_at;
      if (finalStatus === 'sent') {
        if (firstSuccess) {
          await db.query("UPDATE crm_quotations SET status = CASE WHEN status = 'revised' THEN status ELSE 'sent' END, sent_at=$2, sent_by_id=$3, sent_by_name=$4, last_email_id=$5, subject=$6, message=$7, customer_name=$8, contact_person=$9, email=$10, updated_at=$2 WHERE id=$1",
            [id, t, actor.id, actor.name, mail.id, mail.subject, mail.message, cust.name, cust.contact_person, cust.email]);
        } else {
          await db.query('UPDATE crm_quotations SET last_email_id=$2, updated_at=$3 WHERE id=$1', [id, mail.id, t]);
        }
      } else {
        await db.query("UPDATE crm_quotations SET last_email_id=$2, status = CASE WHEN sent_at IS NULL AND status <> 'revised' THEN 'failed' ELSE status END, updated_at=$3 WHERE id=$1", [id, mail.id, t]);
      }
      const action = finalStatus === 'sent' ? (mail.kind === 'resend' ? 'quotation.resent' : 'quotation.emailed') : 'quotation.email_failed';
      await addActivity(db, { action, actor, customerId: cust.id, customerName: cust.name, quotationId: id, ip,
        summary: finalStatus === 'sent' ? `Quotation ${id} ${mail.kind === 'resend' ? 'resent' : 'emailed'} to ${mail.toEmail}` : `Email for quotation ${id} to ${mail.toEmail} ${finalStatus === 'failed' ? 'failed' : 'could not be confirmed'}`,
        details: { emailId: mail.id, to: mail.toEmail, subject: mail.subject, status: finalStatus, error: res.error || '', providerMessageId: res.messageId || '', attachment: att ? att.filename : '' } });
    });
    const out = (await pool.query('SELECT * FROM crm_email_logs WHERE id = $1', [mail.id])).rows[0];
    return { ok: finalStatus === 'sent', email: emailOut(out), quotation: await getQuotation(pool, id) };
  }

  async function settledResult(prior) {
    let row = prior;
    if (row.status === 'sending') {
      if (Date.now() - new Date(row.attempted_at).getTime() < 120000) throw new HttpError(409, 'This email is still being sent. Check the history in a moment.', { code: 'send_in_progress' });
      // the server stopped mid-send: we cannot know whether the provider accepted it
      await pool.query("UPDATE crm_email_logs SET status='unconfirmed', error=$2, completed_at=$3 WHERE id=$1 AND status='sending'", [row.id, 'The server stopped while this email was being sent. It is not known whether it was delivered. Check the mailbox / email service dashboard before sending again.', nowIso()]);
      row = (await pool.query('SELECT * FROM crm_email_logs WHERE id = $1', [row.id])).rows[0];
    }
    return { ok: row.status === 'sent', duplicate: true, email: emailOut(row), quotation: await getQuotation(pool, row.quotation_id) };
  }

  /* ---------- analysis, stats, activity ---------- */
  async function rateHistory(query) {
    const customerId = oneLine(query.customerId, 40);
    if (!customerId) throw new HttpError(400, 'Choose a customer.');
    const includeUnsent = query.includeUnsent === '1' || query.includeUnsent === 'true';
    const prodRows = (await pool.query(
      `SELECT COALESCE(NULLIF(i.product_id, ''), i.product_name) AS key, MAX(i.product_name) AS name, MAX(i.unit) AS unit, COUNT(DISTINCT q.id) AS n
       FROM crm_quotation_items i JOIN crm_quotations q ON q.id = i.quotation_id WHERE q.customer_id = $1 ${includeUnsent ? '' : 'AND q.sent_at IS NOT NULL'} GROUP BY 1 ORDER BY 2`, [customerId])).rows;
    const products = prodRows.map(r => ({ key: r.key, name: r.name, unit: r.unit, quotations: Number(r.n) }));
    const productKey = oneLine(query.product, 120);
    const out = { products, product: null, summary: null, series: [] };
    if (!productKey) return out;
    const q = qb(); const w = [`q.customer_id = ${q.p(customerId)}`, `COALESCE(NULLIF(i.product_id, ''), i.product_name) = ${q.p(productKey)}`];
    if (!includeUnsent) w.push('q.sent_at IS NOT NULL');
    if (query.location) w.push(`LOWER(i.location) = ${q.p(oneLine(query.location, 120).toLowerCase())}`);
    if (isYmd(query.from)) w.push(`q.quotation_date >= ${q.p(query.from)}`);
    if (isYmd(query.to)) w.push(`q.quotation_date <= ${q.p(query.to)}`);
    const rows = (await pool.query(
      `SELECT i.*, q.quotation_date, q.sent_at, q.status AS q_status, q.created_at AS q_created, q.sent_by_name, q.created_by_name
       FROM crm_quotation_items i JOIN crm_quotations q ON q.id = i.quotation_id WHERE ${w.join(' AND ')}
       ORDER BY q.quotation_date, q.created_at, i.line_no`, q.params)).rows;
    const byQ = new Map();
    for (const r of rows) {
      if (!byQ.has(r.quotation_id)) byQ.set(r.quotation_id, { quotationId: r.quotation_id, date: r.quotation_date, sentAt: iso(r.sent_at), status: r.q_status, by: r.sent_by_name || r.created_by_name || '', location: r.location, options: [] });
      byQ.get(r.quotation_id).options.push({ supplierId: r.supplier_id, supplierName: r.supplier_name, rate: num(r.rate), rateInclGst: num(r.rate_incl_gst), unit: r.unit, quantity: num(r.quantity), location: r.location, creditDays: r.credit_days === null ? null : Number(r.credit_days) });
    }
    const series = [...byQ.values()]; const lastBySupplier = new Map();
    let prevLowest = null;
    for (const s of series) {
      for (const o of s.options) {
        const k = o.supplierName.toLowerCase() + '|' + String(o.location || '').toLowerCase();
        const prev = lastBySupplier.get(k);
        o.previousRate = prev ? prev.rate : null; o.change = prev ? Math.round((o.rate - prev.rate) * 100) / 100 : null;
        o.changePct = prev && prev.rate ? Math.round(((o.rate - prev.rate) / prev.rate) * 10000) / 100 : null;
        lastBySupplier.set(k, { rate: o.rate, date: s.date });
      }
      const rates = s.options.map(o => o.rate);
      s.lowest = Math.min(...rates); s.highest = Math.max(...rates);
      s.lowestSupplier = s.options.find(o => o.rate === s.lowest).supplierName;
      s.lowestChange = prevLowest === null ? null : Math.round((s.lowest - prevLowest) * 100) / 100;
      s.lowestChangePct = prevLowest ? Math.round(((s.lowest - prevLowest) / prevLowest) * 10000) / 100 : null;
      prevLowest = s.lowest;
    }
    const all = []; series.forEach(s => s.options.forEach(o => all.push({ ...o, date: s.date, quotationId: s.quotationId })));
    if (all.length) {
      const lo = all.reduce((a, b) => (b.rate < a.rate ? b : a)), hi = all.reduce((a, b) => (b.rate > a.rate ? b : a));
      const last = series[series.length - 1];
      out.summary = {
        quotations: series.length, options: all.length, unit: all[0].unit,
        lowest: { rate: lo.rate, date: lo.date, supplierName: lo.supplierName, quotationId: lo.quotationId },
        highest: { rate: hi.rate, date: hi.date, supplierName: hi.supplierName, quotationId: hi.quotationId },
        latest: { date: last.date, quotationId: last.quotationId, lowest: last.lowest, highest: last.highest, lowestSupplier: last.lowestSupplier, options: last.options.map(o => ({ supplierName: o.supplierName, rate: o.rate })) }
      };
    }
    out.product = products.find(p => p.key === productKey) || { key: productKey, name: productKey };
    out.series = series;
    return out;
  }

  async function stats() {
    const one = async (sql, p) => Number((await pool.query(sql, p)).rows[0].n);
    const month = monthStartIso();
    const recent = (await pool.query(`SELECT c.id, c.name, MAX(q.created_at) AS last_at, COUNT(*) AS n, COUNT(q.sent_at) AS sent FROM crm_quotations q JOIN crm_customers c ON c.id = q.customer_id GROUP BY c.id, c.name ORDER BY MAX(q.created_at) DESC LIMIT 8`)).rows;
    return {
      totalCustomers: await one("SELECT COUNT(*) AS n FROM crm_customers WHERE status = 'active'"),
      archivedCustomers: await one("SELECT COUNT(*) AS n FROM crm_customers WHERE status = 'archived'"),
      quotationsGenerated: await one('SELECT COUNT(*) AS n FROM crm_quotations'),
      quotationsSent: await one('SELECT COUNT(*) AS n FROM crm_quotations WHERE sent_at IS NOT NULL'),
      sentThisMonth: await one('SELECT COUNT(*) AS n FROM crm_quotations WHERE sent_at >= $1', [month]),
      failedEmails: await one("SELECT COUNT(*) AS n FROM crm_email_logs WHERE status IN ('failed','unconfirmed')"),
      failedAwaitingRetry: await one("SELECT COUNT(*) AS n FROM crm_quotations WHERE status = 'failed'"),
      drafts: await one("SELECT COUNT(*) AS n FROM crm_quotations WHERE status = 'draft'"),
      recentCustomers: recent.map(r => ({ id: r.id, name: r.name, lastQuotedAt: iso(r.last_at), quotations: Number(r.n), sent: Number(r.sent) })),
      recentActivity: (await listActivity({ limit: 10 })).rows
    };
  }

  const activityOut = r => ({ id: r.id, createdAt: iso(r.created_at), action: r.action, actor: { id: r.actor_id || '', name: r.actor_name || '' }, customerId: r.customer_id, customerName: r.customer_name, quotationId: r.quotation_id, summary: r.summary, details: r.details || {} });
  async function listActivity(query) {
    const q = qb(); const w = [];
    if (query.customerId) w.push(`customer_id = ${q.p(oneLine(query.customerId, 40))}`);
    if (query.quotationId) w.push(`quotation_id = ${q.p(oneLine(query.quotationId, 40))}`);
    if (query.action) w.push(`action LIKE ${q.p(likeTerm(oneLine(query.action, 40)).replace(/^%|%$/g, '') + '%')}`);
    if (query.actor) w.push(`LOWER(actor_name) LIKE ${q.p(likeTerm(oneLine(query.actor, 80)))}`);
    if (isYmd(query.from)) w.push(`created_at >= ${q.p(dayStartIso(query.from))}`);
    if (isYmd(query.to)) w.push(`created_at < ${q.p(dayEndIso(query.to))}`);
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const total = Number((await pool.query(`SELECT COUNT(*) AS n FROM crm_activity_log ${where}`, q.params)).rows[0].n);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 500), offset = Math.max(parseInt(query.offset, 10) || 0, 0);
    const r = await pool.query(`SELECT * FROM crm_activity_log ${where} ORDER BY created_at DESC, id DESC LIMIT ${q.p(limit)} OFFSET ${q.p(offset)}`, q.params);
    return { total, rows: r.rows.map(activityOut) };
  }

  /* ---------- routes ---------- */
  function register(app) {
    const guard = fn => async (req, res) => {
      try {
        if (!pool) throw new HttpError(503, 'Customer features need the Neon database. Set DATABASE_URL first.');
        if (!ready) throw new HttpError(503, 'Customer module is still starting. Please retry in a few seconds.');
        await fn(req, res);
      } catch (e) {
        if (e instanceof HttpError) return res.status(e.status).json({ ok: false, error: e.message, ...e.extra });
        if (e && e.code === '23505') return res.status(409).json({ ok: false, error: 'That record already exists (duplicate).' });
        console.error('[crm] error on', req.method, req.path, '-', e && e.message);
        res.status(500).json({ ok: false, error: 'Server error, please retry.' });
      }
    };
    const R = p => '/api/crm' + p;

    app.get(R('/config'), guard(async (req, res) => {
      const cfg = emailConfig();
      res.json({ ok: true, customerTypes: CUSTOMER_TYPES, emailEnabled: cfg.enabled && !emailBlocked(cfg), emailBlockedReason: emailBlocked(cfg), provider: cfg.enabled ? cfg.provider : '', fromAddress: cfg.enabled ? cfg.fromAddress : '', bccConfigured: !!cfg.bcc, siteProtected: !!siteProtected, today: todayYmd() });
    }));
    app.get(R('/customers'), guard(async (req, res) => res.json({ ok: true, customers: await listCustomers(req.query) })));
    app.post(R('/customers'), guard(async (req, res) => res.status(201).json({ ok: true, customer: await createCustomer(req.body || {}, req.ip) })));
    app.get(R('/customers/:id'), guard(async (req, res) => {
      const r = (await pool.query(CUSTOMER_SELECT + ' WHERE c.id = $1', [req.params.id])).rows[0];
      if (!r) throw new HttpError(404, 'Customer not found.');
      res.json({ ok: true, customer: customerOut(r) });
    }));
    app.patch(R('/customers/:id'), guard(async (req, res) => res.json({ ok: true, ...(await updateCustomer(req.params.id, req.body || {}, req.ip)) })));
    app.post(R('/customers/:id/archive'), guard(async (req, res) => res.json({ ok: true, customer: await setCustomerStatus(req.params.id, 'archived', req.body || {}, req.ip) })));
    app.post(R('/customers/:id/restore'), guard(async (req, res) => res.json({ ok: true, customer: await setCustomerStatus(req.params.id, 'active', req.body || {}, req.ip) })));

    app.post(R('/email-preview'), guard(async (req, res) => {
      const b = req.body || {}; const actor = actorOf(b);
      const cust = (await pool.query('SELECT * FROM crm_customers WHERE id = $1', [oneLine(b.customerId, 40)])).rows[0];
      if (!cust) throw new HttpError(404, 'Pick a customer first.');
      const items = cleanItems(b.items).map(i => ({ ...i }));
      const q = { id: oneLine(b.quotationId, 40) || null, quotationDate: isYmd(b.quotationDate) ? b.quotationDate : todayYmd(), customerName: cust.name, subject: '', message: '' };
      const built = (() => {
        const subjectRaw = oneLine(b.subject, 300) || 'Quotation';
        const r = renderEmail({ quotationNo: q.id, quotationDate: q.quotationDate, customerName: cust.name, contactPerson: cust.contact_person, message: str(b.message, 5000), items, sender: b.sender, terms: Array.isArray(b.terms) ? b.terms.slice(0, 15) : [], validTill: isYmd(b.validTill) ? b.validTill : '', preparedBy: actor.name !== 'Unknown user' ? actor.name : '' });
        return { subject: subjectRaw.replace(/\{QTNO\}/g, q.id || 'QT-(number assigned when sent)'), ...r };
      })();
      res.json({ ok: true, subject: built.subject, html: built.html, text: built.text, to: { email: cust.email, name: cust.contact_person || cust.name }, emailValid: isEmail(cust.email) });
    }));

    app.get(R('/quotations'), guard(async (req, res) => res.json({ ok: true, ...(await listQuotations(req.query)) })));
    app.post(R('/quotations'), guard(async (req, res) => {
      const r = await createQuotation(req.body || {}, req.ip);
      res.status(r.duplicate ? 200 : 201).json({ ok: true, ...r });
    }));
    app.get(R('/quotations/:id'), guard(async (req, res) => {
      const qn = await getQuotation(pool, req.params.id);
      if (!qn) throw new HttpError(404, 'Quotation not found.');
      res.json({ ok: true, quotation: qn });
    }));
    app.patch(R('/quotations/:id'), guard(async (req, res) => res.json({ ok: true, ...(await patchQuotation(req.params.id, req.body || {}, req.ip)) })));
    app.post(R('/quotations/:id/send'), guard(async (req, res) => {
      const r = await sendQuotation(req.params.id, req.body || {}, req.ip);
      res.status(r.ok ? 200 : 502).json(r);
    }));
    app.get(R('/emails/:id'), guard(async (req, res) => {
      const r = (await pool.query('SELECT * FROM crm_email_logs WHERE id = $1', [req.params.id])).rows[0];
      if (!r) throw new HttpError(404, 'Email record not found.');
      res.json({ ok: true, email: emailOut(r, true) });
    }));
    app.get(R('/filters'), guard(async (req, res) => res.json({ ok: true, ...(await filterValues(oneLine(req.query.customerId, 40))) })));
    app.get(R('/rates'), guard(async (req, res) => res.json({ ok: true, ...(await rateHistory(req.query)) })));
    app.get(R('/stats'), guard(async (req, res) => res.json({ ok: true, ...(await stats()) })));
    app.get(R('/activity'), guard(async (req, res) => res.json({ ok: true, ...(await listActivity(req.query)) })));
  }

  return { init, register, isReady: () => ready };
}

module.exports = { createCrm, renderEmail, nameKey, CUSTOMER_TYPES };
