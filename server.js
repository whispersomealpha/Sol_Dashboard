const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const TRADES_FILE = path.join(__dirname, 'trades.json');
const DEBUG_FILE = path.join(__dirname, 'trades_debug.json');

app.use(express.static(__dirname));

app.get('/trades.json', (req, res) => {
  if (fs.existsSync(TRADES_FILE)) {
    res.sendFile(TRADES_FILE);
  } else {
    res.json({ wallet: '', scraped_at: null, trades: [], error: 'No data yet. Click REFRESH to scrape.' });
  }
});

app.get('/debug.json', (req, res) => {
  if (fs.existsSync(DEBUG_FILE)) res.sendFile(DEBUG_FILE);
  else res.json({ message: 'No debug data yet — run a scrape first' });
});

let scraping = false;
let lastLog = '';

app.post('/scrape', (req, res) => {
  if (scraping) return res.json({ status: 'busy', message: 'Scrape already in progress' });
  scraping = true;
  lastLog = '';
  console.log('[server] Scrape triggered');

  execFile('node', [path.join(__dirname, 'scraper.js')], { timeout: 180000 }, (err, stdout, stderr) => {
    scraping = false;
    lastLog = stdout + stderr;
    console.log('[server] Scrape finished');
    console.log(lastLog);
    if (err && !fs.existsSync(TRADES_FILE)) {
      return res.json({ status: 'error', message: err.message, log: lastLog });
    }
    res.json({ status: 'ok', log: lastLog });
  });
});

app.get('/scrape/status', (req, res) => {
  res.json({ scraping, hasData: fs.existsSync(TRADES_FILE), log: lastLog });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

app.listen(PORT, () => console.log(`Sol Dashboard on port ${PORT}`));
