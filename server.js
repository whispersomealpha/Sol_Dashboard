const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const TRADES_FILE = path.join(__dirname, 'trades.json');

// ── Serve static files (dashboard.html, trades.json) ─────────────────────────
app.use(express.static(__dirname));

// ── GET /trades.json — always return latest data ──────────────────────────────
app.get('/trades.json', (req, res) => {
  if (fs.existsSync(TRADES_FILE)) {
    res.sendFile(TRADES_FILE);
  } else {
    res.json({ wallet: '', scraped_at: null, trades: [], error: 'No data yet. Hit /scrape first.' });
  }
});

// ── POST /scrape — trigger the scraper ────────────────────────────────────────
let scraping = false;

app.post('/scrape', (req, res) => {
  if (scraping) {
    return res.json({ status: 'busy', message: 'Scrape already in progress' });
  }
  scraping = true;
  console.log('[scrape] Starting...');

  execFile('node', [path.join(__dirname, 'scraper.js')], { timeout: 120000 }, (err, stdout, stderr) => {
    scraping = false;
    if (err) {
      console.error('[scrape] Error:', err.message);
      return res.json({ status: 'error', message: err.message, stderr });
    }
    console.log('[scrape] Done.');
    res.json({ status: 'ok', message: 'Scrape complete', log: stdout });
  });
});

// ── GET /scrape/status ────────────────────────────────────────────────────────
app.get('/scrape/status', (req, res) => {
  res.json({ scraping, hasData: fs.existsSync(TRADES_FILE) });
});

// ── Root → dashboard ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Sol Dashboard running on port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Trigger scrape: POST http://localhost:${PORT}/scrape`);
});
