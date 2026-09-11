// Daily vending machine summary bot for online.unicum.ru (UOnline telemetry)
// Logs in (solving the image captcha via the Anthropic API), scrapes per-machine
// daily sales and current errors, and sends a summary to Telegram.

const { chromium } = require('playwright');

const BASE_URL = 'https://online.unicum.ru';
const COMPBM = process.env.COMPBM || '/xsAAA==';
const LOGIN_URL = `${BASE_URL}/machines.php?compbm=${COMPBM}`;
const LIST_URL = `${BASE_URL}/machines.php?compbm=${COMPBM}&vendsperday=cost`;

const SITE_LOGIN = requireEnv('SITE_LOGIN');
const SITE_PASSWORD = requireEnv('SITE_PASSWORD');
const TELEGRAM_BOT_TOKEN = requireEnv('TELEGRAM_BOT_TOKEN');
const TELEGRAM_CHAT_ID = requireEnv('TELEGRAM_CHAT_ID');
const ANTHROPIC_API_KEY = requireEnv('ANTHROPIC_API_KEY');

const MAX_LOGIN_ATTEMPTS = 8;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function solveCaptcha(pngBuffer) {
  const b64 = pngBuffer.toString('base64');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 20,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: b64 },
            },
            {
              type: 'text',
              text:
                'This is a CAPTCHA: five gold cursive digits on a hatched background. ' +
                'Reply with ONLY the five digits, nothing else, no spaces.',
            },
          ],
        },
      ],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Anthropic API error ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  const text = (data.content || []).map((c) => c.text || '').join('').trim();
  const match = text.match(/\d{4,6}/);
  if (!match) throw new Error(`Could not parse captcha digits from model reply: "${text}"`);
  return match[0];
}

async function login(page) {
  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    console.log(`Login attempt ${attempt}...`);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });

    const captchaImg = page.locator('img.captid');
    await captchaImg.waitFor({ state: 'visible', timeout: 15000 });
    const buffer = await captchaImg.screenshot();
    const digits = await solveCaptcha(buffer);
    console.log(`Captcha solved as: ${digits}`);

    await page.locator('input[placeholder="Input login"]').fill(SITE_LOGIN);
    await page.locator('input[placeholder="Input password"]').fill(SITE_PASSWORD);
    await page.locator('input[placeholder="Input symbols"]').fill(digits);
    await page.locator('button[type="submit"]').click();
    await page.waitForLoadState('networkidle');

    const bodyText = await page.locator('body').innerText();
    if (bodyText.includes('Captcha not match') || bodyText.includes('Unknown error')) {
      console.log('Login attempt failed, retrying with a fresh captcha...');
      continue;
    }
    if (await page.locator('input[placeholder="Input login"]').count() === 0) {
      console.log('Login successful.');
      return true;
    }
  }
  throw new Error(`Failed to log in after ${MAX_LOGIN_ATTEMPTS} attempts`);
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
  const rows = await page.evaluate(() => {
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
  return rows;
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

async function sendTelegram(text) {
  const resp = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    }
  );
  if (!resp.ok) {
    throw new Error(`Telegram API error ${resp.status}: ${await resp.text()}`);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await login(page);
    const machines = await scrapeMachines(page);

    for (const m of machines) {
      m.errors = await scrapeErrors(page, m.bm);
    }

    const message = formatMessage(machines);
    console.log(message);
    await sendTelegram(message);
    console.log('Report sent to Telegram.');
  } catch (err) {
    console.error('Fatal error:', err);
    try {
      await sendTelegram(`⚠️ Ошибка при формировании сводки по автоматам:\n${err.message}`);
    } catch (_) {
      /* ignore secondary failure */
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
