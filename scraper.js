const puppeteer = require('puppeteer-core');
const fs = require('fs');
const { execSync } = require('child_process');

const WALLET = 'AyMTHSbURADUynv9W83yypTNiNRzU59PpCWGkqyMegGQ';
const PAGE_URL = `https://gmgn.ai/sol/address/${WALLET}`;
const OUTPUT_FILE = 'trades.json';

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  try { return execSync('which chromium || which chromium-browser || which google-chrome', { encoding: 'utf8' }).trim(); } catch (_) {}
  throw new Error('Could not find Chromium. Set PUPPETEER_EXECUTABLE_PATH env var.');
}

const CHROME_PATH = findChrome();
console.log('[scraper] Chrome:', CHROME_PATH);

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parse cookies from env var GMGN_COOKIES
// Format: "name1=value1; name2=value2" (copy from browser DevTools → Application → Cookies)
function parseCookies() {
  const raw = process.env.GMGN_COOKIES || '';
  if (!raw) return [];
  return raw.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
    const idx = pair.indexOf('=');
    return {
      name: pair.slice(0, idx).trim(),
      value: pair.slice(idx + 1).trim(),
      domain: '.gmgn.ai',
      path: '/',
    };
  });
}

function normalizeTrades(raw) {
  const candidates = [
    raw?.data?.activities,
    raw?.data?.data?.activities,
    raw?.activities,
    raw?.data?.trades,
    raw?.trades,
    raw?.data?.items,
    raw?.items,
    Array.isArray(raw?.data) ? raw.data : null,
    Array.isArray(raw) ? raw : null,
  ];
  const arr = candidates.find(c => Array.isArray(c) && c.length > 0);
  if (!arr) return [];

  return arr.map(item => {
    const isBuy = (item.event_type || item.event || item.type || item.side || '').toLowerCase().includes('buy');
    const tokenInfo = item.token || item.token_info || {};
    const symbol = tokenInfo.symbol || item.token_symbol || item.symbol || '?';
    const addr = tokenInfo.address || item.token_address || item.contract_address || '';
    const ts = item.timestamp ? new Date(item.timestamp * 1000).toISOString().replace('T',' ').slice(0,19) : '';
    const solAmt = item.cost_sol || item.sol_amount || item.quote_amount || item.amount_sol || '';
    const tokenAmt = item.token_amount || item.base_amount || item.amount_token || '';
    const priceUsd = item.price || item.price_usd || tokenInfo.price || '';
    const pnl = item.realized_profit != null ? item.realized_profit : item.pnl ?? null;
    const tx = item.tx_hash || item.signature || item.transaction_hash || item.tx || '';
    return {
      time: ts, type: isBuy ? 'BUY' : 'SELL',
      token: symbol, token_address: addr,
      amount_token: String(tokenAmt), amount_sol: String(solAmt),
      price_usd: String(priceUsd),
      pnl: pnl != null ? String(pnl) : null,
      tx,
    };
  }).filter(t => t.token !== '?');
}

async function scrapeGMGN() {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME_PATH,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--window-size=1400,900'],
  });

  const page = await browser.newPage();

  // Stealth
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Inject cookies if provided
  const cookies = parseCookies();
  if (cookies.length > 0) {
    await page.setCookie(...cookies);
    console.log(`[scraper] Injected ${cookies.length} cookies`);
  } else {
    console.log('[scraper] No GMGN_COOKIES env var set — trying without auth');
  }

  // Capture ALL json responses and log them for debugging
  const capturedApis = [];
  const allResponses = [];

  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('gmgn.ai')) return;
    const status = response.status();
    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const json = await response.json();
      allResponses.push({ url, status, data: json });
      // Log every API call so we can see what's available
      console.log(`[api] ${status} ${url.slice(0, 120)}`);
      // Check if it looks like trade data
      if (/activit|trade|swap|transaction|history/i.test(url)) {
        capturedApis.push({ url, data: json });
      }
    } catch (_) {}
  });

  console.log('[scraper] Navigating to:', PAGE_URL);
  await page.goto(PAGE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(5000);

  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await sleep(1000);
  }

  if (capturedApis.length === 0 && allResponses.length === 0) {
    console.log('[scraper] Nothing captured — reloading...');
    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(5000);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await sleep(1000);
    }
  }

  // Save full debug dump so we can inspect what GMGN returned
  const debugPath = OUTPUT_FILE.replace('.json', '_debug.json');
  fs.writeFileSync(debugPath, JSON.stringify({
    captured_trade_apis: capturedApis.map(r => ({ url: r.url, keys: Object.keys(r.data || {}) })),
    all_api_urls: allResponses.map(r => `[${r.status}] ${r.url}`),
  }, null, 2));
  console.log('[scraper] Debug dump saved to', debugPath);

  await browser.close();

  // Extract trades
  let trades = [];
  for (const { url, data } of capturedApis) {
    const norm = normalizeTrades(data);
    if (norm.length > 0) {
      console.log(`[scraper] Extracted ${norm.length} trades from:`, url.slice(0, 80));
      trades.push(...norm);
    }
  }

  // If no trades from known endpoints, try ALL captured json responses
  if (trades.length === 0 && allResponses.length > 0) {
    console.log('[scraper] No trades from targeted endpoints — scanning all responses...');
    for (const { url, data } of allResponses) {
      const norm = normalizeTrades(data);
      if (norm.length > 0) {
        console.log(`[scraper] Found ${norm.length} trades in:`, url.slice(0, 80));
        trades.push(...norm);
      }
    }
  }

  const seen = new Set();
  trades = trades.filter(t => {
    if (!t.tx) return true;
    if (seen.has(t.tx)) return false;
    seen.add(t.tx); return true;
  });
  trades.sort((a,b) => new Date(b.time) - new Date(a.time));

  const result = {
    wallet: WALLET,
    scraped_at: new Date().toISOString(),
    source: trades.length > 0 ? 'api_intercept' : 'no_data',
    apis_hit: allResponses.map(r => `[${r.status}] ${r.url}`),
    trades,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`[scraper] Done — ${trades.length} trades saved`);

  // If still empty, tell the user what to do
  if (trades.length === 0) {
    console.log('\n--- NO TRADES EXTRACTED ---');
    console.log('All GMGN API calls captured:');
    allResponses.forEach(r => console.log(`  [${r.status}] ${r.url}`));
    console.log('\nFix: Set GMGN_COOKIES env var in Railway with your session cookies.');
    console.log('How to get cookies: Open gmgn.ai in Chrome → DevTools (F12) → Application → Cookies → gmgn.ai');
    console.log('Copy all cookies as: "name1=value1; name2=value2; ..."');
  }
}

scrapeGMGN().catch(err => { console.error('[scraper] Fatal:', err.message); process.exit(1); });
