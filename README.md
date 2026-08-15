# Zomato/Swiggy Listing Change Monitor

Pings you on Telegram the moment a restaurant's public Zomato or Swiggy page
shows an offer/discount that wasn't there before (or one that vanished).

---

## Local setup (already done, for reference)

1. `npm install`
2. Copy `.env.example` to `.env` and fill in your real `TELEGRAM_BOT_TOKEN`
   and `TELEGRAM_CHAT_ID`. `.env` is git-ignored -- it never gets committed or
   pushed, so your token stays private even in a public repo.
3. Fill in `config.json` with your restaurants' real Zomato/Swiggy URLs.
   This file has **no secrets in it**, so it's safe to commit and push.
4. `npm run check` -- first run builds the baseline, later runs alert on change.

## Running it 24/7 for free via GitHub Actions

1. Push this folder to a **public** GitHub repo (public repos get unlimited
   free Actions minutes; `.env` never gets pushed because of `.gitignore`,
   so your bot token stays private even though the repo itself is public).
2. In the repo: **Settings -> Secrets and variables -> Actions -> New repository
   secret**. Add two secrets:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
3. The workflow file `.github/workflows/monitor.yml` is already included --
   it runs the check every 30 minutes automatically, using those secrets.
4. Push. Go to the repo's **Actions** tab to watch it run (you can also
   trigger it manually there with "Run workflow").

That's it -- from here it runs whether your laptop is on or off.

## How it detects a "change"

Instead of relying on fragile CSS selectors (Zomato/Swiggy change their
class names often), the script reads the page's full visible text and
pattern-matches offer language: "20% OFF", "FLAT Rs.100 OFF",
"FREE DELIVERY", "BUY 1 GET 1". It stores that list per restaurant per
platform in `state.json`, and on every run diffs the new list against the
old one. Anything added or removed triggers the alert.

**Trade-off to know:** this catches *offer banners*, not silent price bumps
on individual menu items -- that would need a deeper scrape of the full menu.

## Notes

- Uses Playwright with a stealth plugin (playwright-extra +
  puppeteer-extra-plugin-stealth) -- Zomato blocks plain headless browsers
  with a blank page, this works around that.
- Only reads public pages, same as any customer browsing the listing -- no
  login, no scraping behind auth.
- If a page fails to load, the script saves a screenshot to
  debug-screenshots/ so you can see what actually happened.
