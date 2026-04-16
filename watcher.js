const fs       = require('fs');
const path     = require('path');
const { execSync } = require('child_process');

const WALLET       = 'AyMTHSbURADUynv9W83yypTNiNRzU59PpCWGkqyMegGQ';
const TRADES_FILE  = path.join(__dirname, 'trades.json');
const POLL_MS      = parseInt(process.env.WATCH_INTERVAL_MS || '30000'); // 30s default

// ── Helpers ──────────────────────────────────────────────────────────────────

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = ['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/opt/google/chrome/chrome'];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  try { return execSync('which chromium || which chromium-browser || which google-chrome', { encoding: 'utf8' }).trim(); } catch (_) {}
  throw new Error('Chromium not found.');
}

function parseCookieHeader() {
  const raw = process.env.GMGN_COOKIES || '';
  return raw.split(';').map(s => s.trim()).filter(Boolean).join('; ');
}

function loadTrades() {
  try {
    const data = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
    return data.trades || [];
  } catch (_) { return []; }
}

function saveTrades(trades, extra = {}) {
  const existing = (() => { try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch(_) { return {}; } })();
  fs.writeFileSync(TRADES_FILE, JSON.stringify({
    ...existing,
    ...extra,
    trades,
    last_watch: new Date().toISOString(),
  }, null, 2));
}

function normalizeItem(item) {
  const isBuy  = (item.event_type || item.event || item.type || item.side || '').toLowerCase().includes('buy');
  const info   = item.token || item.token_info || {};
  const symbol = info.symbol || item.token_symbol || item.symbol || '?';
  const addr   = info.address || item.token_address || item.contract_address || '';
  const ts     = item.timestamp ? new Date(item.timestamp * 1000).toISOString().replace('T',' ').slice(0,19) : '';
  const solAmt = item.cost_sol  || item.sol_amount   || item.quote_amount || item.amount_sol  || '';
  const tokAmt = item.token_amount || item.base_amount || item.amount_token || '';
  const price  = item.price     || item.price_usd    || info.price || '';
  const pnl    = item.realized_profit != null ? item.realized_profit : item.pnl ?? null;
  const tx     = item.tx_hash   || item.signature    || item.transaction_hash || item.tx || '';
  return {
    time: ts, type: isBuy ? 'BUY' : 'SELL', token: symbol, token_address: addr,
    amount_token: String(tokAmt), amount_sol: String(solAmt),
    price_usd: String(price), pnl: pnl != null ? String(pnl) : null, tx,
    _new: true,   // flag so the dashboard can highlight it
  };
}

// ── Fetch latest page via fetch() (no Puppeteer needed for polling) ───────────
async function fetchLatest() {
  const url = `https://gmgn.ai/api/v1/wallet_activity/sol?wallet=${WALLET}&limit=20`;
  const cookieHeader = parseCookieHeader();

  const res = await fetch(url, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept':          'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer':         'https://gmgn.ai/',
      ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const arr  = json?.data?.activities || json?.activities || json?.data || [];
  return Array.isArray(arr) ? arr : [];
}

// ── State ────────────────────────────────────────────────────────────────────
let watcherRunning = false;
let newTradesCount = 0;
let lastError      = null;
let intervalHandle = null;

async function poll() {
  try {
    const latest   = await fetchLatest();
    const existing = loadTrades();
    const knownTxs = new Set(existing.map(t => t.tx).filter(Boolean));

    const fresh = latest
      .map(normalizeItem)
      .filter(t => t.token !== '?' && t.tx && !knownTxs.has(t.tx));

    if (fresh.length > 0) {
      // Remove _new flag from old trades, prepend new ones
      const cleaned = existing.map(t => ({ ...t, _new: false }));
      const merged  = [...fresh, ...cleaned];
      saveTrades(merged, { watch_new_count: fresh.length });
      newTradesCount += fresh.length;
      console.log(`[watcher] ${new Date().toISOString()} — +${fresh.length} new trade(s): ${fresh.map(t => `${t.type} ${t.token}`).join(', ')}`);
    } else {
      // Still update last_watch timestamp so dashboard knows watcher is alive
      saveTrades(existing.map(t => ({ ...t, _new: false })));
      console.log(`[watcher] ${new Date().toISOString()} — no new trades`);
    }

    lastError = null;
  } catch (err) {
    lastError = err.message;
    console.error(`[watcher] poll error: ${err.message}`);
  }
}

function start() {
  if (watcherRunning) return;
  watcherRunning = true;
  console.log(`[watcher] Starting — polling every ${POLL_MS / 1000}s`);
  poll(); // immediate first poll
  intervalHandle = setInterval(poll, POLL_MS);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  watcherRunning = false;
  console.log('[watcher] Stopped');
}

function status() {
  return { running: watcherRunning, interval_ms: POLL_MS, new_trades_found: newTradesCount, last_error: lastError };
}

module.exports = { start, stop, status };

// Run standalone: node watcher.js
if (require.main === module) {
  start();
  process.on('SIGINT', () => { stop(); process.exit(0); });
}
