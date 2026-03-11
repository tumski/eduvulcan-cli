import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { CliError, EXIT_CODES } from './types.js';

export async function launchBrowser(headless: boolean): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  try {
    const browser = await chromium.launch({
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=WebAuthentication',
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();
    return { browser, context, page };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`Browser initialization failed: ${reason}`, EXIT_CODES.BROWSER_INIT);
  }
}
