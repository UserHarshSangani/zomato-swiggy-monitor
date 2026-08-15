/**
 * Zomato/Swiggy Listing Change Monitor
 * -------------------------------------
 * Loads each restaurant's public Zomato/Swiggy page, scans the visible text
 * for offer patterns (e.g. "20% OFF", "FLAT ₹100 OFF", "FREE DELIVERY"),
 * and compares against the last known snapshot. If anything changed
 * (an offer appeared, disappeared, or the % changed), it pings you on Telegram.
 *
 * Run manually:   node monitor.js
 * Run on a loop:  node monitor.js --watch   (checks every N minutes, per config.json)
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");

// Patterns we consider "offer signals" on a restaurant page.
// Kept broad on purpose -- better to over-catch and let you eyeball the diff
// than to miss something because of one narrow regex.
const OFFER_PATTERNS = [
  /\d{1,3}%\s*OFF/gi,
  /FLAT\s*(?:RS\.?|₹)\s*\d+\s*OFF/gi,
  /FREE\s*DELIVERY/gi,
  /BUY\s*1\s*GET\s*1/gi,
  /B1G1/gi,
];

function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function extractOffers(page) {
  // Grab all visible text on the page, then pull out offer-looking substrings.
  const bodyText = await page.evaluate(() => document.body.innerText || "");
  const found = new Set();

  for (const pattern of OFFER_PATTERNS) {
    const matches = bodyText.match(pattern) || [];
    for (const m of matches) {
      // normalize whitespace so "20%   OFF" and "20% OFF" count as the same thing
      found.add(m.replace(/\s+/g, " ").trim().toUpperCase());
    }
  }

  return [...found].sort();
}

async function scrapePlatform(browser, url) {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-IN,en;q=0.9",
    },
  });

  // Some sites (Zomato in particular) reject the HTTP/2 handshake from
  // headless Chrome with net::ERR_HTTP2_PROTOCOL_ERROR. Retry once over
  // plain HTTP/1.1-friendly settings before giving up on that page.
  const attempts = [
    { waitUntil: "domcontentloaded", timeout: 45000 },
    { waitUntil: "load", timeout: 60000 },
  ];

  let lastError = null;
  for (const opts of attempts) {
    try {
      await page.goto(url, opts);
      // Give the page a moment to render offer banners after the initial load.
      await page.waitForTimeout(4000);
      const offers = await extractOffers(page);
      await page.close();
      return { ok: true, offers };
    } catch (err) {
      lastError = err;
    }
  }

  // Couldn't load normally after all attempts -- grab a screenshot of
  // whatever's actually on screen (CAPTCHA, block page, cookie wall, etc.)
  // so we can see what's really happening instead of guessing from the error text.
  let screenshotPath = null;
  try {
    const debugDir = path.join(__dirname, "debug-screenshots");
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir);
    const safeName = url.replace(/[^a-z0-9]/gi, "_").slice(0, 80);
    screenshotPath = path.join(debugDir, `${safeName}-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath });
  } catch {
    screenshotPath = null;
  }

  await page.close();
  return {
    ok: false,
    error: lastError ? lastError.message : "unknown error",
    screenshotPath,
  };
}

async function sendTelegramAlert(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.error("Telegram not configured: missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars.");
    return;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("Telegram send failed:", res.status, body);
  }
}

function diffOffers(previous = [], current = []) {
  const prevSet = new Set(previous);
  const currSet = new Set(current);

  const added = current.filter((o) => !prevSet.has(o));
  const removed = previous.filter((o) => !currSet.has(o));

  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

async function checkRestaurant(browser, state, restaurant) {
  const platforms = [
    { key: "zomato", label: "Zomato", url: restaurant.zomatoUrl },
    { key: "swiggy", label: "Swiggy", url: restaurant.swiggyUrl },
  ];

  for (const platform of platforms) {
    if (!platform.url || platform.url.includes("PASTE-ACTUAL-SLUG-HERE")) {
      continue; // skip unconfigured entries
    }

    const stateKey = `${restaurant.name}::${platform.key}`;
    console.log(`Checking ${restaurant.name} on ${platform.label}...`);

    const result = await scrapePlatform(browser, platform.url);

    if (!result.ok) {
      console.error(`  ! Failed to load: ${result.error}`);
      if (result.screenshotPath) {
        console.error(`    Debug screenshot saved: ${result.screenshotPath}`);
      }
      // Optional: alert on repeated scrape failures too (page structure may have changed)
      continue;
    }

    const previousOffers = state[stateKey] || [];
    const diff = diffOffers(previousOffers, result.offers);

    if (diff.changed && state[stateKey] !== undefined) {
      // Only alert if we HAD a previous snapshot -- first run just establishes baseline.
      const lines = [`⚠️ <b>${restaurant.name} — ${platform.label}</b> offer change detected:`];
      if (diff.added.length) lines.push(`➕ Added: ${diff.added.join(", ")}`);
      if (diff.removed.length) lines.push(`➖ Removed: ${diff.removed.join(", ")}`);
      lines.push(platform.url);

      const message = lines.join("\n");
      console.log(message.replace(/\n/g, " | "));
      await sendTelegramAlert(message);
    } else {
      console.log(`  ✓ No change (${result.offers.length} offer signal(s) live)`);
    }

    state[stateKey] = result.offers;
  }
}

async function runCheck() {
  const config = loadJSON(CONFIG_PATH, null);
  if (!config) {
    console.error("config.json not found or invalid.");
    process.exit(1);
  }

  const state = loadJSON(STATE_PATH, {});
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-http2", "--disable-blink-features=AutomationControlled"],
  });

  try {
    for (const restaurant of config.restaurants) {
      await checkRestaurant(browser, state, restaurant);
    }
  } finally {
    await browser.close();
    saveJSON(STATE_PATH, state);
  }
}

async function main() {
  const watch = process.argv.includes("--watch");

  if (!watch) {
    await runCheck();
    return;
  }

  const config = loadJSON(CONFIG_PATH, {});
  const intervalMs = (config.checkIntervalMinutes || 30) * 60 * 1000;

  console.log(`Watch mode: checking every ${config.checkIntervalMinutes || 30} min. Ctrl+C to stop.`);
  // Run once immediately, then on the interval.
  await runCheck();
  setInterval(runCheck, intervalMs);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
