const puppeteer = require('puppeteer-core');
const fs = require('fs');
const { execSync } = require('child_process');

const WALLET = 'AyMTHSbURADUynv9W83yypTNiNRzU59PpCWGkqyMegGQ';
const OUTPUT_FILE = 'trades.json';

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  try { return execSync('which chromium || which chromium-browser || which google-chrome', { encoding: 'utf8' }).trim(); } catch (_) {}
  throw new Error('Chromium not found. Set PUPPETEER_EXECUTABLE_PATH.');
}

function parseCookies() {
  const raw = process.env.GMGN_COOKIES || '';
  if (!raw) { console.log('[cookies] GMGN_COOKIES not set'); return []; }
  return raw.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
    const idx = pair.indexOf('=');
    return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim(), domain: '.gmgn.ai', path: '/' };
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeTrades(raw) {
  const candidates = [
    raw?.data?.activities, raw?.data?.data?.activities, raw?.activities,
    raw?.data?.trades, raw?.trades, raw?.data?.items, raw?.items,
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
      time: ts, type: isBuy ? 'BUY' : 'SELL', token: symbol, token_address: addr,
      amount_token: String(tokenAmt), amount_sol: String(solAmt),
      price_usd: String(priceUsd), pnl: pnl != null ? String(pnl) : null, tx,
    };
  }).filter(t => t.token !== '?');
}

// Known GMGN API endpoint patterns for wallet activity
const API_ENDPOINTS = [
  `https://gmgn.ai/api/v1/wallet_activity/sol?wallet=${WALLET}&limit=100`,
  `https://gmgn.ai/defi/quotation/v1/wallet_activity/sol?wallet=${WALLET}&limit=100`,
  `https://gmgn.ai/sol/wallet/${WALLET}/activity?limit=100`,
  `https://gmgn.ai/api/v1/wallet_holdings/sol/${WALLET}?limit=50`,
];

async function scrapeGMGN() {
  const CHROME_PATH = findChrome();
  console.log('[chrome]', CHROME_PATH);

  const browser = await puppeteer.launch({
    headless: 'new', executablePath: CHROME_PATH,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled','--window-size=1400,900'],
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'application/json, text/plain, */*', 'Referer': 'https://gmgn.ai/' });

  // Inject cookies
  const cookies = parseCookies();
  if (cookies.length > 0) {
    await page.setCookie(...cookies);
    console.log(`[cookies] Injected ${cookies.length} cookies:`, cookies.map(c => c.name).join(', '));
  }

  // ── Strategy 1: Hit known API endpoints directly ──────────────────────────
  console.log('\n[strategy 1] Direct API calls...');
  let trades = [];
  const allApiLogs = [];

  for (const endpoint of API_ENDPOINTS) {
    try {
      const response = await page.goto(endpoint, { waitUntil: 'networkidle0', timeout: 20000 });
      const status = response.status();
      const text = await page.evaluate(() => document.body.innerText);
      console.log(`  [${status}] ${endpoint.slice(0, 80)}`);
      allApiLogs.push(`[${status}] ${endpoint}`);
      try {
        const json = JSON.parse(text);
        const norm = normalizeTrades(json);
        if (norm.length > 0) {
          console.log(`  ✅ Got ${norm.length} trades!`);
          trades.push(...norm);
          break;
        } else {
          // Log top-level keys to understand structure
          console.log(`  keys: ${Object.keys(json).join(', ')}`);
          if (json.data) console.log(`  data keys: ${Object.keys(json.data).join(', ')}`);
        }
      } catch (e) {
        console.log(`  parse error: ${e.message}`);
        console.log(`  response: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`  error: ${e.message.slice(0, 80)}`);
      allApiLogs.push(`[ERR] ${endpoint}`);
    }
  }

  // ── Strategy 2: Load wallet page and intercept XHR ───────────────────────
  if (trades.length === 0) {
    console.log('\n[strategy 2] Intercept XHR from wallet page...');
    const PAGE_URL = `https://gmgn.ai/sol/address/${WALLET}`;
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
        console.log(`  [${status}] ${url.slice(0, 100)}`);
        if (/activit|trade|swap|transaction|history/i.test(url)) capturedApis.push({ url, data: json });
      } catch (_) {}
    });

    await page.goto(PAGE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(5000);
    for (let i = 0; i < 4; i++) { await page.evaluate(() => window.scrollBy(0, 800)); await sleep(1000); }

    // Try all captured responses
    const sources = [...capturedApis, ...allResponses.filter(r => !capturedApis.find(c => c.url === r.url))];
    for (const { url, data } of sources) {
      const norm = normalizeTrades(data);
      if (norm.length > 0) {
        console.log(`  ✅ ${norm.length} trades from: ${url.slice(0, 80)}`);
        trades.push(...norm);
      }
    }
    allResponses.forEach(r => allApiLogs.push(`[${r.status}] ${r.url}`));
  }

  await browser.close();

  // Dedupe + sort
  const seen = new Set();
  trades = trades.filter(t => { if (!t.tx) return true; if (seen.has(t.tx)) return false; seen.add(t.tx); return true; });
  trades.sort((a,b) => new Date(b.time) - new Date(a.time));

  const result = {
    wallet: WALLET,
    scraped_at: new Date().toISOString(),
    source: trades.length > 0 ? 'api' : 'no_data',
    apis_hit: allApiLogs,
    trades,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\n[done] ${trades.length} trades saved to ${OUTPUT_FILE}`);

  if (trades.length === 0) {
    console.log('\n── NO TRADES ──');
    console.log('All URLs hit:');
    allApiLogs.forEach(u => console.log(' ', u));
    console.log('\nIf all return 403/401: your GMGN_COOKIES may be expired or incomplete.');
    console.log('Try refreshing gmgn.ai and copying fresh cookies.');
  }
}

scrapeGMGN().catch(err => { console.error('[fatal]', err.message); process.exit(1); });
