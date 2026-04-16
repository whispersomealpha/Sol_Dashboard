const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const { execFile } = require('child_process');
const watcher  = require('./watcher');

const app   = express();
const PORT  = process.env.PORT || 3000;
const TRADES_FILE = path.join(__dirname, 'trades.json');

app.use(express.static(__dirname));

app.get('/trades.json', (req, res) => {
  if (fs.existsSync(TRADES_FILE)) res.sendFile(TRADES_FILE);
  else res.json({ wallet: '', scraped_at: null, trades: [], error: 'No data yet. Click REFRESH to scrape full history first.' });
});

// ── Full history scrape ───────────────────────────────────────────────────────
let scraping = false;
let lastLog  = '';

app.post('/scrape', (req, res) => {
  if (scraping) return res.json({ status: 'busy', message: 'Scrape already in progress' });
  scraping = true;
  lastLog  = '';
  watcher.stop(); // pause watcher during full scrape
  console.log('[server] Full scrape triggered');

  execFile('node', [path.join(__dirname, 'scraper.js')], { timeout: 600000 }, (err, stdout, stderr) => {
    scraping = false;
    lastLog  = stdout + stderr;
    watcher.start(); // resume watcher after scrape
    if (err && !fs.existsSync(TRADES_FILE)) return res.json({ status: 'error', message: err.message, log: lastLog });
    res.json({ status: 'ok', log: lastLog });
  });
});

app.get('/scrape/status', (req, res) => {
  res.json({ scraping, hasData: fs.existsSync(TRADES_FILE), log: lastLog });
});

// ── Watcher control ───────────────────────────────────────────────────────────
app.post('/watcher/start',  (req, res) => { watcher.start();  res.json({ status: 'ok', ...watcher.status() }); });
app.post('/watcher/stop',   (req, res) => { watcher.stop();   res.json({ status: 'ok', ...watcher.status() }); });
app.get('/watcher/status',  (req, res) => res.json(watcher.status()));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

app.listen(PORT, () => {
  console.log(`[server] Sol Dashboard on port ${PORT}`);
  // Auto-start watcher if we already have trade data
  if (fs.existsSync(TRADES_FILE)) {
    console.log('[server] Trade data found — starting watcher automatically');
    watcher.start();
  } else {
    console.log('[server] No trade data yet — run a full scrape first, then watcher will auto-start');
  }
});
