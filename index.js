// Daily vending machine summary bot for online.unicum.ru (UOnline telemetry)
//
// Flow:
//  1. Reuse a saved browser session (cookies) if we have one and it's still valid -
//     no login/captcha needed most days.
//  2. If the session is gone/expired, log in: solve the captcha automatically via
//     OpenAI (gpt-4o vision) for a few attempts.
//  3. If OpenAI can't crack it either, send the captcha photo to Telegram and wait
//     for the owner to type the digits back as a reply.
//  4. Scrape per-machine daily sales + current errors and send a summary to Telegram.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = 'https://online.unicum.ru';
const COMPBM = process.env.COMPBM || '/xsAAA==';
const LOGIN_URL = `${BASE_URL}/machines.php?compbm=${COMPBM}`;
const LIST_URL = `${BASE_URL}/machines.php?compbm=${COMPBM}&vendsperday=cost`;
const SESSION_PATH = process.env.SESSION_PATH || '/data/session.json';

const SITE_LOGIN = requireEnv('SITE_LOGIN');
const SITE_PASSWORD = requireEnv('SITE_PASSWORD');
const TELEGRAM_BOT_TOKEN = requireEnv('TELEGRAM_BOT_TOKEN');
const TELEGRAM_CHAT_ID = requireEnv('TELEGRAM_CHAT_ID');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

const OPENAI_CAPTCHA_ATTEMPTS = 3;
const HUMAN_CAPTCHA_ATTEMPTS = 3;
const HUMAN_REPLY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const HUMAN_REPLY_POLL_TIMEOUT_S = 25; // Telegram long-poll timeout per request

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------- Telegram helpers ----------

async function telegramApi(method, body) {
  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    throw new Error(`Telegram ${method} error: ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function sendTelegramText(text) {
  return telegramApi('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text });
}

async function sendTelegramMarkdown(text) {
  return telegramApi('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'MarkdownV2',
  });
}

async function sendTelegramPhoto(pngBuffer, caption) {
  const form = new FormData();
  form.append('chat_id', String(TELEGRAM_CHAT_ID));
  form.append('caption', caption);
  form.append('photo', new Blob([pngBuffer], { type: 'image/png' }), 'captcha.png');
  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    throw new Error(`Telegram sendPhoto error: ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function getTelegramUpdates(offset) {
  const resp = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=${HUMAN_REPLY_POLL_TIMEOUT_S}&offset=${offset}`
  );
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    throw new Error(`Telegram getUpdates error: ${JSON.stringify(data)}`);
  }
  return data.result;
}

// Clears any backlog and returns the offset to use for the next getUpdates call.
async function currentUpdateOffset() {
  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=0`);
  const data = await resp.json();
  if (!data.ok) return 0;
  const updates = data.result || [];
  if (updates.length === 0) return 0;
  return updates[updates.length - 1].update_id + 1;
}

async function waitForHumanCaptcha(sentAtMs) {
  let offset = await currentUpdateOffset();
  const deadline = Date.now() + HUMAN_REPLY_TIMEOUT_MS;
  log('Waiting for human captcha reply on Telegram...');
  while (Date.now() < deadline) {
    const updates = await getTelegramUpdates(offset);
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg || String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) continue;
      if (msg.date * 1000 < sentAtMs) continue;
      const text = (msg.text || '').trim();
      const match = text.match(/\d{4,6}/);
      if (match) {
        log(`Got human captcha reply: ${match[0]}`);
        return match[0];
      }
    }
  }
  throw new Error('Timed out waiting for a captcha reply on Telegram');
}

// ---------- OpenAI captcha solving ----------

async function solveCaptchaOpenAI(pngBuffer) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const b64 = pngBuffer.toString('base64');
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 20,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'This is a CAPTCHA: five gold cursive digits on a hatched background. ' +
                'Reply with ONLY the five digits, nothing else, no spaces.',
            },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        },
      ],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`OpenAI API error: ${JSON.stringify(data)}`);
  }
  const text = data.choices?.[0]?.message?.content?.trim() || '';
  const match = text.match(/\d{4,6}/);
  if (!match) throw new Error(`Could not parse captcha digits from OpenAI reply: "${text}"`);
  return match[0];
}

// ---------- Site automation ----------

async function isLoggedIn(page) {
  await page.goto(LIST_URL, { waitUntil: 'networkidle' });
  return (await page.locator('input[placeholder="Input login"]').count()) === 0;
}

async function attemptLoginOnce(page, digits) {
  await page.locator('input[placeholder="Input login"]').fill(SITE_LOGIN);
  await page.locator('input[placeholder="Input password"]').fill(SITE_PASSWORD);
  await page.locator('input[placeholder="Input symbols"]').fill(digits);
  await page.locator('button[type="submit"]').click();
  await page.waitForLoadState('networkidle');

  const bodyText = await page.locator('body').innerText();
  if (bodyText.includes('Captcha not match') || bodyText.includes('Unknown error')) {
    return false;
  }
  return (await page.locator('input[placeholder="Input login"]').count()) === 0;
}

async function login(page) {
  let totalAttempts = 0;

  for (let i = 0; i < OPENAI_CAPTCHA_ATTEMPTS; i++) {
    totalAttempts++;
    log(`Login attempt ${totalAttempts} (OpenAI)...`);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
    const captchaImg = page.locator('img.captid');
    await captchaImg.waitFor({ state: 'visible', timeout: 15000 });
    const buffer = await captchaImg.screenshot();

    let digits;
    try {
      digits = await solveCaptchaOpenAI(buffer);
      log(`OpenAI read captcha as: ${digits}`);
    } catch (err) {
      log('OpenAI captcha solving failed:', err.message);
      break; // stop trying OpenAI, fall through to human fallback
    }

    if (await attemptLoginOnce(page, digits)) {
      log('Login successful via OpenAI.');
      return;
    }
    log('OpenAI captcha attempt did not match, retrying...');
  }

  log('Falling back to human captcha entry via Telegram.');
  for (let i = 0; i < HUMAN_CAPTCHA_ATTEMPTS; i++) {
    totalAttempts++;
    log(`Login attempt ${totalAttempts} (human via Telegram)...`);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
    const captchaImg = page.locator('img.captid');
    await captchaImg.waitFor({ state: 'visible', timeout: 15000 });
    const buffer = await captchaImg.screenshot();

    const sentAtMs = Date.now();
    await sendTelegramPhoto(
      buffer,
      '🔐 Не смог сам разобрать капчу для входа в UOnline.\n' +
        'Ответьте на это сообщение пятью цифрами с картинки (в течение 15 минут).'
    );
    const digits = await waitForHumanCaptcha(sentAtMs);

    if (await attemptLoginOnce(page, digits)) {
      log('Login successful via human entry.');
      await sendTelegramText('✅ Спасибо, вошёл. Формирую отчёт...');
      return;
    }
    await sendTelegramText('❌ Капча не подошла, пробую ещё раз, пришлю новую картинку.');
  }

  throw new Error(`Failed to log in after ${totalAttempts} attempts`);
}

async function ensureLoggedIn(context, page) {
  if (fs.existsSync(SESSION_PATH)) {
    log('Found saved session, checking if still valid...');
    if (await isLoggedIn(page)) {
      log('Saved session is still valid, no login needed.');
      return;
    }
    log('Saved session expired, logging in fresh...');
  } else {
    log('No saved session found, logging in fresh...');
  }

  await login(page);

  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  await context.storageState({ path: SESSION_PATH });
  log(`Saved session to ${SESSION_PATH}`);
}

// Reads the current state of the machines table. On a fresh page load the
// grid can briefly show every row cloned from the first one before each
// row's real data has finished populating - callers should re-read if the
// result looks duplicated (see scrapeMachines).
async function readMachineRows(page) {
  return page.evaluate(() => {
    const table = document.querySelector('table.general_content_table');
    if (!table) return [];
    const trs = Array.from(table.querySelectorAll('tr')).slice(1); // skip header
    return trs
      .map((tr) => {
        const cells = Array.from(tr.querySelectorAll('td,th')).map((c) =>
          c.innerText.trim().replace(/\s+/g, ' ')
        );
        if (!cells[0]) return null;
        return {
          serial: cells[0],
          type: cells[1] || '',
          address: cells[2] || '',
          location: cells[3] || '',
          status: cells[6] || '',
          route: cells[8] || '',
          name: cells[9] || '',
          salesRaw: cells[13] || '0',
        };
      })
      .filter(Boolean);
  });
}

async function scrapeMachines(page) {
  await page.goto(LIST_URL, { waitUntil: 'networkidle' });

  // The table can briefly be empty right after navigation - give it a moment
  // to render before reading.
  let rows = await readMachineRows(page);
  for (let attempt = 0; attempt < 5 && rows.length === 0; attempt++) {
    log(`Machine table empty (attempt ${attempt + 1}/5), re-reading...`);
    await page.waitForTimeout(1000);
    rows = await readMachineRows(page);
  }

  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="curstat.php"]')).map((a) =>
      a.getAttribute('href')
    )
  );

  return rows
    .map((row, i) => {
      const [countStr, amountStr] = row.salesRaw.includes('/')
        ? row.salesRaw.split('/')
        : [row.salesRaw, '0'];
      const bmMatch = (hrefs[i] || '').match(/bm=([^&]+)/);
      return {
        ...row,
        salesCount: parseInt(countStr, 10) || 0,
        salesAmount: parseFloat(amountStr) || 0,
        bm: bmMatch ? bmMatch[1] : null,
      };
    })
    .filter((m) => !m.status.includes('Не привязан')); // archived/unlinked machines
}

// Some physical vending machines are registered in UOnline as several
// independently-monitored modules (e.g. a snack module and a hot-drinks
// module inside the same cabinet) - they show up as separate rows sharing
// the same serial/name/address but with different "bm" board IDs, and each
// has its own errors/loading-list/sales data. Group those rows back into one
// physical machine per report, merging their per-module data, so the same
// cabinet isn't reported to the owner multiple times.
function groupMachines(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.serial}|${row.address}|${row.location}`;
    let group = groups.get(key);
    if (!group) {
      group = { ...row, bms: [], salesCount: 0, salesAmount: 0 };
      groups.set(key, group);
    }
    if (row.bm) group.bms.push(row.bm);
    group.salesCount += row.salesCount;
    group.salesAmount += row.salesAmount;
  }
  return Array.from(groups.values());
}

// The per-machine "current errors" page (curerrors.php) is a thin shell that
// embeds the real, legacy-styled error report inside an iframe
// (#legacy-frame). That legacy page marks each active error with
// <font color="FF0000">...</font> - everything else (headings, "no errors
// found" lines, coin/bill counters) is plain text. We pull out just the red
// lines, plus their "started at / last confirmed" suffix up to the next <br>.
async function scrapeErrors(page, bm) {
  if (!bm) return [];
  await page.goto(`${BASE_URL}/vm/curerrors.php?bm=${encodeURIComponent(bm)}`, {
    waitUntil: 'networkidle',
  });

  const frame = page.frameLocator('#legacy-frame');
  try {
    await frame.locator('body').waitFor({ state: 'attached', timeout: 10000 });
  } catch (err) {
    log(`Could not load error details frame for bm=${bm}: ${err.message}`);
    return [];
  }

  return frame.locator('body').evaluate((body) => {
    const reds = Array.from(body.querySelectorAll('font[color="FF0000" i]'));
    return reds.map((el) => {
      let text = el.textContent || '';
      let node = el.nextSibling;
      while (node && !(node.nodeType === 1 && node.nodeName === 'BR')) {
        text += node.textContent || '';
        node = node.nextSibling;
      }
      return text.replace(/\s+/g, ' ').trim();
    });
  });
}

// "К загрузке" (restock list) lives in the same #legacy-frame pattern as the
// errors page: a plain table with columns [row number, product name, qty to
// load]. We only keep rows that actually need loading (qty > 0).
async function scrapeLoadingList(page, bm) {
  if (!bm) return [];
  await page.goto(`${BASE_URL}/vm/vmccalcload.php?bm=${encodeURIComponent(bm)}`, {
    waitUntil: 'networkidle',
  });

  const frame = page.frameLocator('#legacy-frame');
  try {
    await frame.locator('body').waitFor({ state: 'attached', timeout: 10000 });
  } catch (err) {
    log(`Could not load "to load" frame for bm=${bm}: ${err.message}`);
    return [];
  }

  const rows = await frame.locator('body').evaluate((body) => {
    const table = Array.from(body.querySelectorAll('table')).find((t) =>
      /Наименование/.test(t.innerText)
    );
    if (!table) return [];
    return Array.from(table.querySelectorAll('tr'))
      .slice(1) // skip header
      .map((tr) => {
        const cells = Array.from(tr.querySelectorAll('td,th')).map((c) => c.innerText.trim());
        return { name: cells[1] || '', qty: cells[2] || '0' };
      })
      .filter((r) => r.name);
  });

  return rows.filter((r) => {
    const n = parseFloat(r.qty.replace(',', '.'));
    return !isNaN(n) && n > 0;
  });
}

function novosibirskDateParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Novosibirsk',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

// "Анализ продаж" shows, per category (Снеки/Кофе/...), a per-day breakdown
// as "<count> / <amount>" table cells with dates as column headers
// (DD-MM-YYYY). We only need today's column. Category rows are marked with
// the "fs-bigger"/"bg-bluegrey" classes, and always have exactly as many
// trailing cells as there are date columns (regardless of how many label
// columns precede them), so we align by counting from the end of the row.
async function scrapeSalesAnalysis(page, bm) {
  if (!bm) return { dateLabel: '', categories: [] };
  await page.goto(`${BASE_URL}/vm/chart.php?bm=${encodeURIComponent(bm)}`, {
    waitUntil: 'networkidle',
  });

  const data = await page.evaluate(() => {
    const table =
      document.querySelector('table.vmsalestable') ||
      Array.from(document.querySelectorAll('table')).find(
        (t) => /Ячейка/.test(t.innerText) && /Итоговые/.test(t.innerText)
      );
    if (!table) return null;
    const trs = Array.from(table.querySelectorAll('tr'));
    if (trs.length === 0) return null;
    const headerCells = Array.from(trs[0].querySelectorAll('td,th')).map((c) => c.innerText.trim());
    const dateRegex = /^\d{2}-\d{2}-\d{4}$/;
    const dates = headerCells.filter((t) => dateRegex.test(t));
    const categories = [];
    for (const tr of trs.slice(1)) {
      if (!/fs-bigger|bg-bluegrey/.test(tr.className || '')) continue;
      const cells = Array.from(tr.querySelectorAll('td,th')).map((c) => c.innerText.trim());
      const dateCells = cells.slice(-dates.length);
      const byDate = {};
      dates.forEach((d, i) => {
        byDate[d] = dateCells[i] || '';
      });
      categories.push({ name: cells[0], byDate });
    }
    return { dates, categories };
  });

  if (!data) return { dateLabel: '', categories: [] };

  const { day, month, year } = novosibirskDateParts(new Date());
  const todayLabel = `${day}-${month}-${year}`;

  const categories = data.categories.map((c) => {
    const cell = c.byDate[todayLabel] || '';
    const match = cell.match(/^(\d+)\s*\/\s*([\d.]+)/);
    return {
      name: c.name,
      count: match ? parseInt(match[1], 10) : 0,
      amount: match ? parseFloat(match[2]) : 0,
    };
  });

  return { dateLabel: todayLabel, categories };
}

// ---------- Telegram MarkdownV2 formatting ----------

function escapeMd(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// Wraps plain text lines into a Telegram "expandable blockquote" - collapsed
// by default, tap to expand - so a long list (like a restock table) doesn't
// eat up the whole message. In MarkdownV2 this is a normal blockquote
// (each line prefixed with an unescaped ">") that starts right after an
// empty bold marker "**" and ends with "||" glued to the last line; that
// unmatched **/|| pair is what tells Telegram's parser to make it
// expandable instead of a plain always-open blockquote.
function toExpandableQuote(lines) {
  const quoted = lines.map((l) => `>${escapeMd(l)}`).join('\n');
  return `**${quoted}||`;
}

function formatMachineMessage(m, index, loadingList, salesData) {
  const lines = [];
  const link = `${BASE_URL}/vm/index.php?bm=${encodeURIComponent(m.bm || '')}`;
  const title = m.name ? `${m.name} (${m.serial})` : m.serial;
  const addressPart = `${m.address}${m.location ? ', ' + m.location : ''}`;
  lines.push(`${index}\\. Автомат [${escapeMd(title)}](${link}) \\(${escapeMd(addressPart)}\\)`);
  lines.push('');

  lines.push('*К загрузке:*');
  if (loadingList.length === 0) {
    lines.push(escapeMd('загружать нечего (остатки в норме)'));
  } else {
    const tableLines = loadingList.map((r) => `${r.name} — ${r.qty}`);
    lines.push(toExpandableQuote(tableLines));
  }
  lines.push('');

  lines.push('*Текущие ошибки:*');
  if (m.errors.length === 0) {
    lines.push(escapeMd('ошибок нет'));
  } else {
    m.errors.forEach((e, i) => lines.push(`${i + 1}\\. ${escapeMd(e)}`));
  }
  lines.push('');

  lines.push('*Анализ продаж:*');
  if (salesData.categories.length === 0) {
    lines.push(escapeMd('нет данных'));
  } else {
    const parts = salesData.categories.map(
      (c) => `${escapeMd(c.name.toLowerCase())} \\= ${escapeMd(c.amount.toFixed(2))} руб`
    );
    const total = salesData.categories.reduce((s, c) => s + c.amount, 0);
    const [dd, mm] = salesData.dateLabel ? salesData.dateLabel.split('-') : ['', ''];
    lines.push(
      `${escapeMd(`${dd}.${mm}`)}  ${parts.join(', ')}\\. Всего ${escapeMd(total.toFixed(2))} руб\\.`
    );
  }

  return lines.join('\n');
}

async function main() {
  log('Bot run starting...');
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    log('Browser launched.');

    const contextOptions = fs.existsSync(SESSION_PATH) ? { storageState: SESSION_PATH } : {};
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    await ensureLoggedIn(context, page);

    const rawRows = await scrapeMachines(page);

    // TEMP DIAGNOSTIC: the machines-list table's serial/name/address/status
    // columns have been showing identical (row-1) text for every row, even
    // though each row's "bm" genuinely points at a different real machine.
    // Before trusting any other page as a source of correct identity, log
    // what curstat.php and index.php actually show per bm so we can see
    // where the real name/address/status text lives. Logged to Railway
    // console only - not sent to Telegram.
    for (const row of rawRows) {
      if (!row.bm) continue;
      try {
        await page.goto(`${BASE_URL}/vm/curstat.php?bm=${encodeURIComponent(row.bm)}`, {
          waitUntil: 'networkidle',
        });
        const title = await page.title();
        const bodyText = await page.locator('body').innerText();
        log(`DIAG curstat bm=${row.bm} title="${title}" body(0..800)="${bodyText.slice(0, 800).replace(/\n+/g, ' | ')}"`);
      } catch (err) {
        log(`DIAG curstat bm=${row.bm} failed: ${err.message}`);
      }
      try {
        await page.goto(`${BASE_URL}/vm/index.php?bm=${encodeURIComponent(row.bm)}`, {
          waitUntil: 'networkidle',
        });
        const title = await page.title();
        const bodyText = await page.locator('body').innerText();
        log(`DIAG index bm=${row.bm} title="${title}" body(0..800)="${bodyText.slice(0, 800).replace(/\n+/g, ' | ')}"`);
      } catch (err) {
        log(`DIAG index bm=${row.bm} failed: ${err.message}`);
      }
    }

    const machines = groupMachines(rawRows);

    const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Novosibirsk' });
    const totalCount = rawRows.reduce((s, m) => s + m.salesCount, 0);
    const totalAmount = rawRows.reduce((s, m) => s + m.salesAmount, 0);
    await sendTelegramText(
      `📊 Сводка по автоматам за ${today}\n` +
        `Автоматов: ${machines.length}. Итого продаж: ${totalCount} шт. на ${totalAmount.toFixed(2)} ₽`
    );

    let index = 1;
    for (const m of machines) {
      try {
        // A physical machine can have several bm modules (see groupMachines).
        // The errors and "to load" pages turn out to show the whole cabinet's
        // data no matter which module's bm you pass in - querying every bm
        // just repeats the same list several times - so we fetch those once,
        // from the first module. The sales-analysis chart IS genuinely
        // per-module (each module sells a different category), so that one
        // is still fetched per bm and merged.
        const mainBm = m.bms[0] || null;
        m.errors = await scrapeErrors(page, mainBm);
        const loadingList = await scrapeLoadingList(page, mainBm);

        const categoriesByName = new Map();
        let dateLabel = '';
        for (const bm of m.bms) {
          const bmSales = await scrapeSalesAnalysis(page, bm);
          if (bmSales.dateLabel) dateLabel = bmSales.dateLabel;
          for (const c of bmSales.categories) {
            if (c.name.trim().toLowerCase() === 'ингредиенты') continue; // not a real sales category
            const prev = categoriesByName.get(c.name) || { name: c.name, count: 0, amount: 0 };
            prev.count += c.count;
            prev.amount += c.amount;
            categoriesByName.set(c.name, prev);
          }
        }
        m.bm = mainBm;
        const salesData = { dateLabel, categories: Array.from(categoriesByName.values()) };
        const msg = formatMachineMessage(m, index, loadingList, salesData);
        log(msg);
        await sendTelegramMarkdown(msg);
      } catch (err) {
        log(`Failed to build/send report for machine ${m.serial}: ${err.message}`);
        await sendTelegramText(
          `⚠️ Не удалось собрать отчёт по автомату ${m.serial}: ${err.message}`
        );
      }
      index++;
    }
    log('Report sent to Telegram.');
  } catch (err) {
    console.error('Fatal error:', err);
    try {
      await sendTelegramText(`⚠️ Ошибка при формировании сводки по автоматам:\n${err.stack || err.message}`);
    } catch (notifyErr) {
      console.error('Also failed to notify Telegram:', notifyErr);
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}

process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled rejection:', reason);
  try {
    await sendTelegramText(`⚠️ Необработанная ошибка в боте автоматов:\n${reason?.stack || reason}`);
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});

process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err);
  try {
    await sendTelegramText(`⚠️ Необработанное исключение в боте автоматов:\n${err.stack || err.message}`);
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});

main();
