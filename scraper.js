const puppeteer = require('puppeteer-core');
const fs = require('fs');
const { execSync } = require('child_process');

const WALLET = 'AyMTHSbURADUynv9W83yypTNiNRzU59PpCWGkqyMegGQ';
const OUTPUT_FILE = 'trades.json';
const PAGE_SIZE = 100;      // items per API page
const MAX_PAGES = 50;       // safety cap — 50 * 100 = 5000 trades max

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = ['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/opt/google/chrome/chrome'];
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

// Extract trade array + next cursor from any GMGN response shape
function extractPage(json) {
  // Find the array of trades
  const candidates = [
    json?.data?.activities, json?.data?.data?.activities, json?.activities,
    json?.data?.trades, json?.trades, json?.data?.items, json?.items,
    Array.isArray(json?.data) ? json.data : null,
    Array.isArray(json) ? json : null,
  ];
  const arr = candidates.find(c => Array.isArray(c) && c.length > 0) || [];

  // Find cursor for next page — GMGN uses various names
  const cursor = json?.data?.next
    || json?.data?.cursor
    || json?.data?.next_cursor
    || json?.next
    || json?.cursor
    || json?.data?.last_timestamp
    || (arr.length > 0 ? arr[arr.length - 1]?.timestamp : null)
    || null;

  return { arr, cursor, total: json?.data?.total || json?.total || null };
}

function normalizeItem(item) {
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
}

// Fetch a single URL via puppeteer page (cookies already injected)
async function fetchJson(page, url) {
  const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
  const status = response.status();
  const text = await page.evaluate(() => document.body.innerText);
  return { status, text };
}

// ── Strategy 1: Direct paginated API calls ───────────────────────────────────
async function strategy1_directAPI(page, allApiLogs) {
  console.log('\n[strategy 1] Paginated direct API calls...');
  const allTrades = [];

  // Base endpoint patterns — we try each and use whichever works
  const BASE_ENDPOINTS = [
    `https://gmgn.ai/api/v1/wallet_activity/sol?wallet=${WALLET}&limit=${PAGE_SIZE}`,
    `https://gmgn.ai/defi/quotation/v1/wallet_activity/sol?wallet=${WALLET}&limit=${PAGE_SIZE}`,
  ];

  let workingBase = null;

  // Find which endpoint works
  for (const base of BASE_ENDPOINTS) {
    try {
      const { status, text } = await fetchJson(page, base);
      allApiLogs.push(`[${status}] ${base}`);
      console.log(`  [${status}] ${base.slice(0, 90)}`);
      if (status === 200) {
        const json = JSON.parse(text);
        const { arr } = extractPage(json);
        if (arr.length > 0) {
          workingBase = base;
          console.log(`  ✅ Working endpoint found! ${arr.length} items on first page`);
          // Add first page trades
          allTrades.push(...arr.map(normalizeItem).filter(t => t.token !== '?'));
          // Now paginate
          await paginate(page, base, json, allTrades, allApiLogs);
          break;
        } else {
          console.log(`  keys: ${Object.keys(json).join(', ')}`);
          if (json.data) console.log(`  data keys: ${Object.keys(json.data || {}).join(', ')}`);
        }
      } else {
        console.log(`  → blocked (${status})`);
      }
    } catch (e) {
      console.log(`  error: ${e.message.slice(0, 80)}`);
      allApiLogs.push(`[ERR] ${base}`);
    }
  }

  return allTrades;
}

async function paginate(page, baseUrl, firstPageJson, allTrades, allApiLogs) {
  let { cursor, arr, total } = extractPage(firstPageJson);
  let pageNum = 1;

  if (total) console.log(`  Total trades reported by API: ${total}`);

  while (cursor && arr.length === PAGE_SIZE && pageNum < MAX_PAGES) {
    pageNum++;
    await sleep(500); // be polite

    // Try cursor param, then offset
    const nextUrl = `${baseUrl}&cursor=${cursor}`;
    console.log(`  [page ${pageNum}] cursor=${String(cursor).slice(0,20)}... fetching...`);

    try {
      const { status, text } = await fetchJson(page, nextUrl);
      allApiLogs.push(`[${status}] page${pageNum} ${nextUrl.slice(0, 80)}`);

      if (status !== 200) {
        console.log(`  → stopped at page ${pageNum} (status ${status})`);
        break;
      }

      const json = JSON.parse(text);
      const page_result = extractPage(json);
      arr = page_result.arr;
      cursor = page_result.cursor;

      const newTrades = arr.map(normalizeItem).filter(t => t.token !== '?');
      allTrades.push(...newTrades);
      console.log(`  page ${pageNum}: +${newTrades.length} trades (total so far: ${allTrades.length})`);

      if (arr.length < PAGE_SIZE) {
        console.log(`  → last page reached (got ${arr.length} < ${PAGE_SIZE})`);
        break;
      }
    } catch (e) {
      console.log(`  → pagination error: ${e.message.slice(0, 80)}`);
      break;
    }
  }
}

// ── Strategy 2: Load wallet page, click "Load More", intercept XHR ───────────
async function strategy2_pageIntercept(page, allApiLogs) {
  console.log('\n[strategy 2] XHR intercept with Load More clicks...');
  const PAGE_URL = `https://gmgn.ai/sol/address/${WALLET}`;
  const allTrades = [];
  const seenUrls = new Set();

  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('gmgn.ai') || seenUrls.has(url)) return;
    const status = response.status();
    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const json = await response.json();
      seenUrls.add(url);
      allApiLogs.push(`[${status}] ${url}`);
      console.log(`  [${status}] ${url.slice(0, 100)}`);
      const { arr } = extractPage(json);
      if (arr.length > 0) {
        const trades = arr.map(normalizeItem).filter(t => t.token !== '?');
        allTrades.push(...trades);
        console.log(`  +${trades.length} trades intercepted`);
      }
    } catch (_) {}
  });

  console.log('  Loading wallet page...');
  await page.goto(PAGE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(4000);

  // Scroll + click Load More repeatedly
  let clicks = 0;
  const MAX_CLICKS = 30;

  while (clicks < MAX_CLICKS) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1500);

    // Try to find and click "Load More" button
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, div[class*="more"], span[class*="more"], a'));
      const loadMore = btns.find(el => {
        const txt = el.innerText?.toLowerCase() || '';
        return txt.includes('load more') || txt.includes('more') || txt.includes('show more');
      });
      if (loadMore) { loadMore.click(); return true; }
      return false;
    });

    if (!clicked) {
      console.log(`  No Load More button found after ${clicks} clicks`);
      break;
    }
    clicks++;
    console.log(`  Clicked Load More (${clicks})`);
    await sleep(2000);
  }

  return allTrades;
}

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
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://gmgn.ai/' });

  const cookies = parseCookies();
  if (cookies.length > 0) {
    await page.setCookie(...cookies);
    console.log(`[cookies] ${cookies.length} cookies injected:`, cookies.map(c => c.name).join(', '));
  }

  const allApiLogs = [];
  let trades = [];

  // Try direct API first (faster, gets all pages)
  trades = await strategy1_directAPI(page, allApiLogs);

  // Fallback to page intercept
  if (trades.length === 0) {
    trades = await strategy2_pageIntercept(page, allApiLogs);
  }

  await browser.close();

  // Dedupe by tx hash
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
    total: trades.length,
    source: trades.length > 0 ? 'api' : 'no_data',
    apis_hit: allApiLogs,
    trades,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\n[done] ${trades.length} trades saved`);

  if (trades.length === 0) {
    console.log('\n── EMPTY — all endpoints hit:');
    allApiLogs.forEach(u => console.log(' ', u));
    console.log('\nSet GMGN_COOKIES env var with fresh cookies from gmgn.ai (F12 → Application → Cookies)');
  }
}

scrapeGMGN().catch(err => { console.error('[fatal]', err.message); process.exit(1); });
