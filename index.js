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
//
// The process runs continuously (not as a one-shot cron job) so it can also
// listen for an on-demand "/report" command on Telegram:
//  - Every day at DAILY_REPORT_HOUR (Novosibirsk time) it automatically sends
//    a report for the FULL PREVIOUS DAY (e.g. an 08:00 run covers yesterday
//    00:00-24:00), since that's the only day whose sales are complete by then.
//  - Sending "/report" (or "отчет"/"отчёт") on Telegram at any time triggers
//    an immediate report for TODAY so far, in real time.
// A file on the persistent volume tracks the last date the automatic report
// ran, so a restart mid-day never sends it twice.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = 'https://online.unicum.ru';
const COMPBM = process.env.COMPBM || '/xsAAA==';
const LOGIN_URL = `${BASE_URL}/machines.php?compbm=${COMPBM}`;
const LIST_URL = `${BASE_URL}/machines.php?compbm=${COMPBM}&vendsperday=cost`;
const SESSION_PATH = process.env.SESSION_PATH || '/data/session.json';
const LAST_AUTO_RUN_PATH = process.env.LAST_AUTO_RUN_PATH || '/data/last_auto_run_date.txt';

const SITE_LOGIN = requireEnv('SITE_LOGIN');
const SITE_PASSWORD = requireEnv('SITE_PASSWORD');
const TELEGRAM_BOT_TOKEN = requireEnv('TELEGRAM_BOT_TOKEN');
// The owner's personal chat - used for login/captcha prompts and crash
// alerts, and always one of the report recipients.
const TELEGRAM_CHAT_ID = requireEnv('TELEGRAM_CHAT_ID');
// Optional extra chat ids (e.g. a shared team group) that also receive
// reports and can trigger the "/report" command, comma-separated.
const TELEGRAM_EXTRA_CHAT_IDS = (process.env.TELEGRAM_EXTRA_CHAT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const REPORT_CHAT_IDS = Array.from(new Set([String(TELEGRAM_CHAT_ID), ...TELEGRAM_EXTRA_CHAT_IDS]));
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

const TIMEZONE = 'Asia/Novosibirsk';
const DAILY_REPORT_HOUR = 8; // local hour to auto-send the full-previous-day report
// Matches an explicit "/report" command, or any message that mentions
// "отчет"/"отчёт" (e.g. "сформировать отчёт", "пришли отчет") - this bot
// only ever gets messages from its owner, so being permissive here is fine.
// NOTE: no \b word-boundary around the Cyrillic words - JS regex \b is
// defined in terms of ASCII \w, so it never matches next to Cyrillic
// letters (they're never treated as "word" chars), meaning \bотчёт\b would
// silently never match anything.
const REPORT_COMMAND_RE = /^\/report\b|отчет|отчёт/i;

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

async function sendTelegramText(text, chatId = TELEGRAM_CHAT_ID) {
  return telegramApi('sendMessage', { chat_id: chatId, text });
}

async function sendTelegramMarkdown(text, chatId = TELEGRAM_CHAT_ID) {
  return telegramApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'MarkdownV2',
  });
}

// Reports AND login/captcha prompts go to every configured chat (the
// owner's personal chat plus any extra chats such as a shared team group -
// see TELEGRAM_EXTRA_CHAT_IDS). Only crash/fatal-error alerts stay
// personal-only (sendTelegramText / sendTelegramMarkdown above, called with
// no chatId), since those are an operational concern for the owner only.
async function broadcastText(text) {
  for (const chatId of REPORT_CHAT_IDS) {
    try {
      await sendTelegramText(text, chatId);
    } catch (err) {
      log(`Failed to send to chat ${chatId}: ${err.message}`);
    }
  }
}

async function broadcastMarkdown(text) {
  for (const chatId of REPORT_CHAT_IDS) {
    try {
      await sendTelegramMarkdown(text, chatId);
    } catch (err) {
      log(`Failed to send to chat ${chatId}: ${err.message}`);
    }
  }
}

async function sendTelegramPhoto(pngBuffer, caption, chatId = TELEGRAM_CHAT_ID) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
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

// Login/captcha prompts now go to every configured chat too (personal +
// any group chats) - whoever sees it first can reply with the digits.
async function broadcastPhoto(pngBuffer, caption) {
  for (const chatId of REPORT_CHAT_IDS) {
    try {
      await sendTelegramPhoto(pngBuffer, caption, chatId);
    } catch (err) {
      log(`Failed to send photo to chat ${chatId}: ${err.message}`);
    }
  }
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

// Telegram only allows ONE long-poll getUpdates call in flight at a time per
// bot token, so both the "wait for a human captcha reply" flow and the
// "listen for the /report command" flow have to share a single polling
// loop instead of each running their own. waitForHumanCaptcha registers
// itself here and the loop resolves it as soon as a matching reply arrives.
let pendingCaptchaWait = null;

function waitForHumanCaptcha(sentAtMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingCaptchaWait && pendingCaptchaWait.resolve === resolve) {
        pendingCaptchaWait = null;
        reject(new Error('Timed out waiting for a captcha reply on Telegram'));
      }
    }, HUMAN_REPLY_TIMEOUT_MS);
    pendingCaptchaWait = { sentAtMs, resolve, reject, timer };
    log('Waiting for human captcha reply on Telegram...');
  });
}

// The single shared Telegram update listener: dispatches captcha replies to
// waitForHumanCaptcha (above) and the report command to onReportCommand
// (set by the caller that owns report generation - see main()).
let onReportCommand = null;

async function telegramUpdateLoop() {
  let offset = await currentUpdateOffset();
  log('Listening for Telegram updates...');
  for (;;) {
    let updates;
    try {
      updates = await getTelegramUpdates(offset);
    } catch (err) {
      log('Telegram update poll failed, retrying shortly:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg) continue;
      const chatId = String(msg.chat.id);
      const text = (msg.text || '').trim();

      // Not a chat we know about (personal or an extra/group chat from
      // TELEGRAM_EXTRA_CHAT_IDS) - log it so its chat id can be found (e.g.
      // right after adding the bot to a new group chat and sending a test
      // message there), then ignore it.
      if (!REPORT_CHAT_IDS.includes(chatId)) {
        log(
          `Message from an unconfigured chat_id=${chatId} (type=${msg.chat.type}, title="${
            msg.chat.title || msg.chat.username || ''
          }"): "${text}" - add this id to TELEGRAM_EXTRA_CHAT_IDS if it should receive reports.`
        );
        continue;
      }

      // Captcha replies can come from any configured chat (personal or a
      // group) - the captcha photo is broadcast to all of them, so whoever
      // gets there first can answer it.
      if (pendingCaptchaWait && msg.date * 1000 >= pendingCaptchaWait.sentAtMs) {
        const match = text.match(/\d{4,6}/);
        if (match) {
          log(`Got human captcha reply: ${match[0]}`);
          clearTimeout(pendingCaptchaWait.timer);
          const { resolve } = pendingCaptchaWait;
          pendingCaptchaWait = null;
          resolve(match[0]);
          continue;
        }
      }

      if (REPORT_COMMAND_RE.test(text) && onReportCommand) {
        onReportCommand(text);
      }
    }
  }
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
    await broadcastPhoto(
      buffer,
      '🔐 Не смог сам разобрать капчу для входа в UOnline.\n' +
        'Ответьте на это сообщение пятью цифрами с картинки (в течение 15 минут).'
    );
    const digits = await waitForHumanCaptcha(sentAtMs);

    if (await attemptLoginOnce(page, digits)) {
      log('Login successful via human entry.');
      await broadcastText('✅ Спасибо, вошёл. Формирую отчёт...');
      return;
    }
    await broadcastText('❌ Капча не подошла, пробую ещё раз, пришлю новую картинку.');
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

// The machines-list table (machines.php) has a genuine site bug: every
// row's visible text (serial, name, address, location, status - literally
// every cell, plus any title/class/img attributes) is rendered identical to
// row 1's, no matter which real machine that row actually represents. The
// only trustworthy thing on this page is each row's link to curstat.php,
// whose "bm" query param genuinely identifies a distinct real machine.
// Real identity (serial/address) and online status must be read per-bm from
// curstat.php / curerrors.php instead - see scrapeMachineIdentity and
// scrapeMachineStatus below.
async function scrapeMachineBms(page) {
  await page.goto(LIST_URL, { waitUntil: 'networkidle' });

  // Right after navigation the table (and its links) can briefly be empty -
  // give it a moment to render before reading.
  let hrefs = await readCurstatHrefs(page);
  for (let attempt = 0; attempt < 5 && hrefs.length === 0; attempt++) {
    log(`Machine links empty (attempt ${attempt + 1}/5), re-reading...`);
    await page.waitForTimeout(1000);
    hrefs = await readCurstatHrefs(page);
  }

  const bms = hrefs
    .map((href) => (href || '').match(/bm=([^&]+)/))
    .map((m) => (m ? m[1] : null))
    .filter(Boolean);

  // A machine can appear more than once in the table (route re-listing);
  // de-duplicate by bm.
  return Array.from(new Set(bms));
}

function readCurstatHrefs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="curstat.php"]')).map((a) =>
      a.getAttribute('href')
    )
  );
}

// curstat.php genuinely differs per bm (unlike the list table). It shows the
// machine's real serial ("Торговый автомат <serial> в компании ...") and,
// right after the GUID line, its installation address.
async function scrapeMachineIdentity(page, bm) {
  await page.goto(`${BASE_URL}/vm/curstat.php?bm=${encodeURIComponent(bm)}`, {
    waitUntil: 'networkidle',
  });
  const bodyText = await page.locator('body').innerText();
  const serialMatch = bodyText.match(/Торговый автомат (\S+) в компании/);
  const addressMatch = bodyText.match(/GUID = \S+\s+(.+?)\s+Переопределять/);
  return {
    serial: serialMatch ? serialMatch[1] : bm,
    address: addressMatch ? addressMatch[1].trim() : '',
  };
}

// The per-machine "current errors" page (curerrors.php) is a thin shell that
// embeds the real, legacy-styled error report inside an iframe
// (#legacy-frame). Its first line reads "Статус: OnLine." (or similar) with
// a "Последний обмен данными" timestamp - this is the generic, per-bm signal
// for whether a machine is actually installed and running: a machine that
// isn't (e.g. removed/replaced hardware still left registered in the
// system) shows a non-"OnLine" status such as "модем удален" with a stale
// last-exchange date, instead of a hardcoded serial check. Active errors are
// marked with <font color="FF0000">...</font> in the same page; everything
// else (headings, "no errors found" lines, coin/bill counters) is plain
// text. We pull out the status plus just the red error lines (with their
// "started at / last confirmed" suffix up to the next <br>).
async function scrapeMachineStatus(page, bm) {
  if (!bm) return { online: false, statusText: '', errors: [] };
  await page.goto(`${BASE_URL}/vm/curerrors.php?bm=${encodeURIComponent(bm)}`, {
    waitUntil: 'networkidle',
  });

  const frame = page.frameLocator('#legacy-frame');
  try {
    await frame.locator('body').waitFor({ state: 'attached', timeout: 10000 });
  } catch (err) {
    log(`Could not load error details frame for bm=${bm}: ${err.message}`);
    return { online: false, statusText: '', errors: [] };
  }

  const { fullText, errors } = await frame.locator('body').evaluate((body) => {
    const reds = Array.from(body.querySelectorAll('font[color="FF0000" i]'));
    const errs = reds.map((el) => {
      let text = el.textContent || '';
      let node = el.nextSibling;
      while (node && !(node.nodeType === 1 && node.nodeName === 'BR')) {
        text += node.textContent || '';
        node = node.nextSibling;
      }
      return text.replace(/\s+/g, ' ').trim();
    });
    return { fullText: body.innerText, errors: errs };
  });

  const statusMatch = fullText.match(/Статус:\s*([^.]+)\./);
  const statusText = statusMatch ? statusMatch[1].trim() : '';
  return { online: statusText === 'OnLine', statusText, errors };
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

// The chart.php sales table keys its date columns as "DD-MM-YYYY".
function dashDateLabel(date) {
  const { day, month, year } = novosibirskDateParts(date);
  return `${day}-${month}-${year}`;
}

// For display in messages: "DD.MM.YYYY".
function dotDateLabel(date) {
  const { day, month, year } = novosibirskDateParts(date);
  return `${day}.${month}.${year}`;
}

function novosibirskHour(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    hour12: false,
  });
  return parseInt(fmt.format(date), 10);
}

// "Анализ продаж" shows, per category (Снеки/Кофе/...), a per-day breakdown
// as "<count> / <amount>" table cells with dates as column headers
// (DD-MM-YYYY). The caller picks which day's column to read (dateLabel, in
// that same DD-MM-YYYY format - see targetDateLabel) since a report can
// cover either the full previous day (the daily automatic run) or today so
// far (an on-demand "/report"). Category rows are marked with the
// "fs-bigger"/"bg-bluegrey" classes, and always have exactly as many
// trailing cells as there are date columns (regardless of how many label
// columns precede them), so we align by counting from the end of the row.
async function scrapeSalesAnalysis(page, bm, dateLabel) {
  if (!bm) return { dateLabel, categories: [] };
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

  if (!data) return { dateLabel, categories: [] };

  const categories = data.categories.map((c) => {
    const cell = c.byDate[dateLabel] || '';
    const match = cell.match(/^(\d+)\s*\/\s*([\d.]+)/);
    return {
      name: c.name,
      count: match ? parseInt(match[1], 10) : 0,
      amount: match ? parseFloat(match[2]) : 0,
    };
  });

  return { dateLabel, categories };
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
      (c) =>
        `${escapeMd(c.name.toLowerCase())} ${escapeMd(String(c.count))}шт, ${escapeMd(
          c.amount.toFixed(2)
        )} рублей`
    );
    const total = salesData.categories.reduce((s, c) => s + c.amount, 0);
    const [dd, mm] = salesData.dateLabel ? salesData.dateLabel.split('-') : ['', ''];
    lines.push(
      `${escapeMd(`${dd}.${mm}`)}  ${parts.join(', ')}\\. Всего ${escapeMd(total.toFixed(2))} руб\\.`
    );
  }

  return lines.join('\n');
}

// Runs one full scrape-and-send cycle inside an already-logged-in page,
// reporting sales for dateLabel (a "DD-MM-YYYY" chart.php column - either
// yesterday's full day or today so far). headerNote is appended to the
// summary line's date (e.g. "(за весь день)" or "(данные на 14:32)").
async function generateAndSendReport(page, dateLabel, dateRu, headerNote) {
  const bms = await scrapeMachineBms(page);
  log(`Found ${bms.length} machine(s) in the list: ${bms.join(', ')}`);

  // Build the report machine-by-machine: skip anything not genuinely
  // online (see scrapeMachineStatus - this is how a registered-but-not-
  // physically-installed machine like an old/replaced unit gets excluded,
  // generically, without hardcoding any specific serial number), then pull
  // its real identity, errors, restock list and the target day's sales.
  const machines = [];
  for (const bm of bms) {
    const status = await scrapeMachineStatus(page, bm);
    if (!status.online) {
      log(`Skipping bm=${bm}: not online (status="${status.statusText}")`);
      continue;
    }

    const identity = await scrapeMachineIdentity(page, bm);
    const loadingList = await scrapeLoadingList(page, bm);
    const salesRaw = await scrapeSalesAnalysis(page, bm, dateLabel);
    const categories = salesRaw.categories.filter(
      (c) => c.name.trim().toLowerCase() !== 'ингредиенты' // not a real sales category
    );
    const salesData = { dateLabel: salesRaw.dateLabel, categories };
    const salesCount = categories.reduce((s, c) => s + c.count, 0);
    const salesAmount = categories.reduce((s, c) => s + c.amount, 0);

    machines.push({
      bm,
      serial: identity.serial,
      address: identity.address,
      errors: status.errors,
      loadingList,
      salesData,
      salesCount,
      salesAmount,
    });
  }

  const totalCount = machines.reduce((s, m) => s + m.salesCount, 0);
  const totalAmount = machines.reduce((s, m) => s + m.salesAmount, 0);
  await broadcastText(
    `📊 Сводка по автоматам за ${dateRu} ${headerNote}\n` +
      `Автоматов: ${machines.length}. Итого продаж: ${totalCount} шт. на ${totalAmount.toFixed(2)} ₽`
  );

  let index = 1;
  for (const m of machines) {
    try {
      const msg = formatMachineMessage(m, index, m.loadingList, m.salesData);
      log(msg);
      await broadcastMarkdown(msg);
    } catch (err) {
      log(`Failed to build/send report for machine ${m.serial}: ${err.message}`);
      await broadcastText(`⚠️ Не удалось собрать отчёт по автомату ${m.serial}: ${err.message}`);
    }
    index++;
  }
  log('Report sent to Telegram.');
}

// Launches a fresh browser + logged-in page, runs fn(page), and always
// closes the browser afterwards - used for both the daily automatic run and
// an on-demand "/report" command, each as its own isolated browser session.
async function withLoggedInPage(fn) {
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
    await fn(page);
  } finally {
    if (browser) await browser.close();
  }
}

// Only one report should ever run at a time (shared browser session file on
// disk, plus it would be confusing to interleave two runs' Telegram
// messages) - the daily automatic run and an on-demand command both go
// through this.
let reportInProgress = false;

async function runReport(kind) {
  if (reportInProgress) {
    if (kind === 'manual') {
      await sendTelegramText('⏳ Отчёт уже формируется, подождите немного.');
    }
    return;
  }
  reportInProgress = true;
  try {
    const now = new Date();
    if (kind === 'daily') {
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      await withLoggedInPage((page) =>
        generateAndSendReport(page, dashDateLabel(yesterday), dotDateLabel(yesterday), '(за весь день)')
      );
    } else {
      const fetchedAt = now.toLocaleTimeString('ru-RU', {
        timeZone: TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
      });
      await withLoggedInPage((page) =>
        generateAndSendReport(page, dashDateLabel(now), dotDateLabel(now), `(данные на ${fetchedAt})`)
      );
    }
  } catch (err) {
    console.error('Report run failed:', err);
    try {
      await sendTelegramText(`⚠️ Ошибка при формировании сводки по автоматам:\n${err.stack || err.message}`);
    } catch (notifyErr) {
      console.error('Also failed to notify Telegram:', notifyErr);
    }
  } finally {
    reportInProgress = false;
  }
}

function readLastAutoRunDate() {
  try {
    return fs.readFileSync(LAST_AUTO_RUN_PATH, 'utf8').trim();
  } catch (err) {
    return null;
  }
}

function writeLastAutoRunDate(label) {
  fs.mkdirSync(path.dirname(LAST_AUTO_RUN_PATH), { recursive: true });
  fs.writeFileSync(LAST_AUTO_RUN_PATH, label);
}

// Checked once a minute: fires the automatic full-previous-day report once
// per calendar day, at/after DAILY_REPORT_HOUR Novosibirsk time. Tracking
// "already ran today" on disk means a restart mid-day never double-sends it.
async function dailyScheduleLoop() {
  for (;;) {
    const now = new Date();
    const todayLabel = dashDateLabel(now);
    if (novosibirskHour(now) >= DAILY_REPORT_HOUR && readLastAutoRunDate() !== todayLabel) {
      log('Time for the daily automatic report...');
      await runReport('daily');
      writeLastAutoRunDate(todayLabel);
    }
    await new Promise((r) => setTimeout(r, 60 * 1000));
  }
}

async function main() {
  log('Bot service starting (daily auto report + on-demand /report command).');

  onReportCommand = (text) => {
    log(`Received report command: "${text}"`);
    runReport('manual');
  };

  telegramUpdateLoop().catch((err) => {
    console.error('Telegram update loop crashed:', err);
    process.exit(1);
  });

  await dailyScheduleLoop();
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
