const puppeteer = require('puppeteer-core');
const fs = require('fs');

const WALLET = 'AyMTHSbURADUynv9W83yypTNiNRzU59PpCWGkqyMegGQ';
const URL = `https://gmgn.ai/sol/address/${WALLET}`;
const OUTPUT_FILE = 'trades.json';

// Adjust path for your environment:
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH
  || '/usr/bin/chromium'
  || '/opt/google/chrome/chrome';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    const isBuy = (item.event_type || item.type || item.side || '').toLowerCase().includes('buy');
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
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME_PATH,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled','--window-size=1400,900'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  const capturedApis = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (!/gmgn\.ai\/(api|defi|sol)/i.test(url)) return;
    if (!/activit|trade|swap|transaction|history/i.test(url)) return;
    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const json = await response.json();
      console.log('API hit:', url.slice(0, 100));
      capturedApis.push({ url, data: json });
    } catch (_) {}
  });

  console.log('Navigating to:', URL);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(5000);

  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await sleep(1200);
  }

  if (capturedApis.length === 0) {
    console.log('No APIs yet — reloading...');
    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(5000);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await sleep(1200);
    }
  }

  await browser.close();

  let trades = [];
  for (const { url, data } of capturedApis) {
    const norm = normalizeTrades(data);
    if (norm.length > 0) {
      console.log(`Extracted ${norm.length} trades from:`, url.slice(0, 80));
      trades.push(...norm);
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
    source: capturedApis.length > 0 ? 'api_intercept' : 'no_data',
    apis_hit: capturedApis.map(c => c.url),
    trades,
    ...(trades.length === 0 ? { raw_api_responses: capturedApis } : {}),
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\nSaved ${trades.length} trades -> ${OUTPUT_FILE}`);
}

scrapeGMGN().catch(err => { console.error('Error:', err.message); process.exit(1); });
