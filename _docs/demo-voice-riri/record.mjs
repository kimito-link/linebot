// record.html をPlaywrightで録画する（映像のみ／音声は make_audio.mjs で別途生成）
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOTAL_MS = 20000; // make_audio.mjs の TOTAL_SEC と一致させること

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
  recordVideo: { dir: path.join(__dirname, 'rec'), size: { width: 1280, height: 900 } },
});
const page = await context.newPage();

await page.goto('file://' + path.join(__dirname, 'record.html').replace(/\\/g, '/'));
// フォント・レイアウト確定を待つ
await page.waitForTimeout(600);

await page.evaluate(() => window.runScenario());
await page.waitForTimeout(TOTAL_MS);

await context.close();
await browser.close();
console.log('recorded into rec/');
