const puppeteer = require('puppeteer-core');
const fs = require('fs');
const { execSync } = require('child_process');

const WALLET = 'AyMTHSbURADUynv9W83yypTNiNRzU59PpCWGkqyMegGQ';
const OUTPUT_FILE = 'trades.json';
const MAX_PAGES = 2000; // ~40000 trades max at 20/page

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = ['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/opt/google/chrome/chrome'];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  try { return execSync('which chromium || which chromium-browser || which google-chrome', { encoding: 'utf8' }).trim(); } catch (_) {}
  throw new Error('Chromium not found.');
}

function parseCookies() {
  const raw = process.env.GMGN_COOKIES || '';
  if (!raw) return [];
  return raw.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
    const idx = pair.indexOf('=');
    return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim(), domain: '.gmgn.ai', path: '/' };
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeItem(item) {
  const isBuy  = (item.event_type || item.event || item.type || item.side || '').toLowerCase().includes('buy');
  const info   = item.token || item.token_info || {};
  const symbol = info.symbol || item.token_symbol || item.symbol || '?';
  const addr   = info.address || item.token_address || item.contract_address || '';
  const ts     = item.timestamp ? new Date(item.timestamp * 1000).toISOString().replace('T',' ').slice(0,19) : '';
  const solAmt = item.cost_sol || item.sol_amount || item.quote_amount || item.amount_sol || '';
  const tokAmt = item.token_amount || item.base_amount || item.amount_token || '';
  const price  = item.price || item.price_usd || info.price || '';
  const pnl    = item.realized_profit != null ? item.realized_profit : item.pnl ?? null;
  const tx     = item.tx_hash || item.signature || item.transaction_hash || item.tx || '';
  return {
    time: ts, type: isBuy ? 'BUY' : 'SELL', token: symbol, token_address: addr,
    amount_token: String(tokAmt), amount_sol: String(solAmt),
    price_usd: String(price), pnl: pnl != null ? String(pnl) : null, tx,
  };
}

async function fetchJson(page, url) {
  const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  const status = response.status();
  const text = await page.evaluate(() => document.body.innerText);
  return { status, text };
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
    console.log(`[cookies] injected: ${cookies.map(c => c.name).join(', ')}`);
  }

  // ── Fetch first page and dump its full structure ───────────────────────────
  const BASE = `https://gmgn.ai/api/v1/wallet_activity/sol?wallet=${WALLET}&limit=100&size=100&page_size=100`;
  console.log('\n[page 1] fetching...');
  const { status, text } = await fetchJson(page, BASE);
  console.log(`[page 1] status: ${status}`);

  let json;
  try { json = JSON.parse(text); } catch(e) {
    console.log('[page 1] not JSON:', text.slice(0, 300));
    await browser.close(); process.exit(1);
  }

  // ── Dump full structure so we can see exactly what keys exist ─────────────
  console.log('\n[structure] top-level keys:', Object.keys(json));
  if (json.data) {
    console.log('[structure] data keys:', Object.keys(json.data));
    if (json.data.activities) console.log('[structure] activities count:', json.data.activities.length);
    // Log every key that might be a cursor
    const cursorKeys = ['next','cursor','next_cursor','last_timestamp','nextCursor','page','offset','has_more','hasMore'];
    for (const k of cursorKeys) {
      if (json.data[k] !== undefined) console.log(`[structure] data.${k} =`, json.data[k]);
    }
    // Also log all data keys with their values if they're not arrays
    for (const [k, v] of Object.entries(json.data)) {
      if (!Array.isArray(v)) console.log(`[structure] data.${k} =`, v);
    }
  }
  // Log first item keys so we know the trade shape
  const firstPage = json?.data?.activities || json?.data?.trades || json?.data?.items || json?.activities || json?.trades || [];
  if (firstPage.length > 0) {
    console.log('\n[structure] first item keys:', Object.keys(firstPage[0]));
    console.log('[structure] first item sample:', JSON.stringify(firstPage[0]).slice(0, 400));
  }

  // ── Now paginate using whatever cursor mechanism exists ────────────────────
  const tradeMap = new Map();
  const addTrades = (arr) => {
    arr.forEach(item => {
      const t = normalizeItem(item);
      if (t.token === '?') return;
      const key = t.tx || `${t.time}_${t.token}_${t.amount_sol}`;
      tradeMap.set(key, t);
    });
  };

  addTrades(firstPage);
  console.log(`\n[page 1] ${firstPage.length} items, ${tradeMap.size} trades total`);

  // Detect pagination style
  const d = json.data || json;
  let pageNum = 1;

  // Style A: cursor-based
  if (d.next !== undefined || d.cursor !== undefined || d.next_cursor !== undefined) {
    console.log('[pagination] style: cursor');
    let cursor = d.next || d.cursor || d.next_cursor;

    while (cursor && pageNum < MAX_PAGES) {
      pageNum++;
      await sleep(400);
      const url = `${BASE}&cursor=${encodeURIComponent(cursor)}`;
      console.log(`[page ${pageNum}] cursor=${String(cursor).slice(0,30)}...`);
      const { status, text } = await fetchJson(page, url);
      if (status !== 200) { console.log(`  stopped: status ${status}`); break; }
      const j = JSON.parse(text);
      const arr = j?.data?.activities || j?.data?.trades || j?.data?.items || j?.activities || j?.trades || [];
      addTrades(arr);
      console.log(`  +${arr.length} items → ${tradeMap.size} total`);
      const jd = j.data || j;
      cursor = jd.next || jd.cursor || jd.next_cursor;
      if (arr.length === 0) break;
    }
  }

  // Style B: offset/page-based
  else if (d.total !== undefined || firstPage.length === 100 || firstPage.length === 20) {
    console.log('[pagination] style: offset (limit/offset)');
    let offset = firstPage.length;

    while (pageNum < MAX_PAGES) {
      pageNum++;
      await sleep(400);
      const url = `${BASE}&offset=${offset}`;
      console.log(`[page ${pageNum}] offset=${offset}`);
      const { status, text } = await fetchJson(page, url);
      if (status !== 200) { console.log(`  stopped: status ${status}`); break; }
      const j = JSON.parse(text);
      const arr = j?.data?.activities || j?.data?.trades || j?.data?.items || j?.activities || j?.trades || [];
      if (arr.length === 0) { console.log('  empty page — done'); break; }
      addTrades(arr);
      offset += arr.length;
      console.log(`  +${arr.length} items → ${tradeMap.size} total`);
      if (arr.length < 20) { console.log('  partial page — done'); break; }
    }
  }

  // Style C: timestamp-based (use last item's timestamp as "before" param)
  else {
    console.log('[pagination] style: timestamp (before param)');
    let lastTs = firstPage.length > 0 ? firstPage[firstPage.length - 1].timestamp : null;

    while (lastTs && pageNum < MAX_PAGES) {
      pageNum++;
      await sleep(400);
      const url = `${BASE}&before=${lastTs}`;
      console.log(`[page ${pageNum}] before=${lastTs}`);
      const { status, text } = await fetchJson(page, url);
      if (status !== 200) { console.log(`  stopped: status ${status}`); break; }
      const j = JSON.parse(text);
      const arr = j?.data?.activities || j?.data?.trades || j?.data?.items || j?.activities || j?.trades || [];
      if (arr.length === 0) { console.log('  empty page — done'); break; }
      addTrades(arr);
      lastTs = arr[arr.length - 1]?.timestamp;
      console.log(`  +${arr.length} items → ${tradeMap.size} total`);
      if (arr.length < 20) { console.log('  partial page — done'); break; }
    }
  }

  await browser.close();

  let trades = Array.from(tradeMap.values());
  trades.sort((a,b) => new Date(b.time) - new Date(a.time));

  const result = {
    wallet: WALLET, scraped_at: new Date().toISOString(),
    total: trades.length, pages_fetched: pageNum,
    source: trades.length > 0 ? 'api' : 'no_data',
    trades,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\n[done] ${trades.length} trades in ${pageNum} pages`);
}

scrapeGMGN().catch(err => { console.error('[fatal]', err.message); process.exit(1); });
