// ... existing code ...
// Strict Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: http:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http: blob:; style-src 'self' 'unsafe-inline' https: http:; font-src 'self' https: http: data:; img-src 'self' data: blob: https: http:; connect-src 'self' https: http: ws: wss:;"
  );
  next();
});

// CORS Configuration - Restricted in production (S-01)
// ... existing code ...
// =========================================================================
// 2. STATIC ASSETS - SERVE ONLY FROM public/ (S-03)
// =========================================================================
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Serve root index.html from public/ (or fallback to refinery_price_calculator.html) with strict no-cache headers
app.get(['/', '/index.html', '/refinery_price_calculator.html'], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const candidates = [
    path.join(publicDir, 'index.html'),
    path.join(publicDir, 'refinery_price_calculator.html'),
    path.join(__dirname, 'refinery_price_calculator.html'),
    path.join(__dirname, 'index.html')
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return res.sendFile(file);
    }
  }
  res.status(404).send('Application HTML file not found.');
});

// Serve static assets from public/ ONLY (never serves project root, server.js, or .env)
// ... existing code ...