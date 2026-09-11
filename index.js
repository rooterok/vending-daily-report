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

async function scrapeMachines(page) {
  await page.goto(LIST_URL, { waitUntil: 'networkidle' });

  const rows = await page.evaluate(() => {
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
          route: cells[8] || '',
          name: cells[9] || '',
          salesRaw: cells[13] || '0',
        };
      })
      .filter(Boolean);
  });

  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="curstat.php"]')).map((a) =>
      a.getAttribute('href')
    )
  );

  return rows.map((row, i) => {
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
  });
}

async function scrapeErrors(page, bm) {
  if (!bm) return [];
  await page.goto(`${BASE_URL}/vm/curerrors.php?bm=${bm}`, { waitUntil: 'networkidle' });
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table.tbl_planogram'));
    const out = [];
    for (const t of tables) {
      for (const tr of Array.from(t.querySelectorAll('tbody tr'))) {
        const text = tr.innerText.trim().replace(/\s+/g, ' ');
        if (text) out.push(text);
      }
    }
    return out;
  });
}

function formatMessage(machines) {
  const lines = [];
  const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Novosibirsk' });
  lines.push(`📊 Сводка по автоматам за ${today}`);
  lines.push('');

  let totalCount = 0;
  let totalAmount = 0;

  for (const m of machines) {
    const title = m.name ? `${m.name} (${m.serial})` : m.serial;
    lines.push(`🔹 ${title}`);
    lines.push(`   ${m.address}${m.location ? ', ' + m.location : ''}`);
    lines.push(`   Продажи: ${m.salesCount} шт. на ${m.salesAmount.toFixed(2)} ₽`);
    if (m.errors.length === 0) {
      lines.push(`   Ошибки: нет`);
    } else {
      lines.push(`   Ошибки (${m.errors.length}):`);
      for (const e of m.errors) lines.push(`     - ${e}`);
    }
    lines.push('');
    totalCount += m.salesCount;
    totalAmount += m.salesAmount;
  }

  lines.push(`Итого: ${totalCount} шт. на ${totalAmount.toFixed(2)} ₽`);
  return lines.join('\n');
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const contextOptions = fs.existsSync(SESSION_PATH) ? { storageState: SESSION_PATH } : {};
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    await ensureLoggedIn(context, page);

    const machines = await scrapeMachines(page);
    for (const m of machines) {
      m.errors = await scrapeErrors(page, m.bm);
    }

    const message = formatMessage(machines);
    log(message);
    await sendTelegramText(message);
    log('Report sent to Telegram.');
  } catch (err) {
    console.error('Fatal error:', err);
    try {
      await sendTelegramText(`⚠️ Ошибка при формировании сводки по автоматам:\n${err.message}`);
    } catch (_) {
      /* ignore secondary failure */
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
