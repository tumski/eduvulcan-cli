import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import type {
  ContextResponse,
  EduGradeItem,
  EduHomeworkDetail,
  EduHomeworkListItem,
  EduMessageDetail,
  EduMessageListItem,
  EduScheduleItem,
  NormalizedGradeItem,
  NormalizedHomeworkItem,
  NormalizedMessageItem,
  NormalizedScheduleItem,
  NormalizedSnapshot,
  NormalizedStudentRecord,
  StudentContext,
} from './types.js';
import { CliError, EXIT_CODES } from './types.js';

const LOGIN_URL = 'https://eduvulcan.pl/logowanie';
const VERSION = '0.1.0';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function clickFirstAvailable(page: Page, selectors: string[], timeoutMs = 3_000): Promise<string | null> {
  for (const selector of selectors) {
    try {
      await page.locator(selector).first().click({ timeout: timeoutMs });
      return selector;
    } catch {
      // try next selector
    }
  }
  return null;
}

function toCookieHeader(cookies: Awaited<ReturnType<BrowserContext['cookies']>>): string {
  return cookies
    .filter((cookie) => cookie.domain.includes('eduvulcan.pl'))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function stripHtml(input: string | undefined): string | null {
  if (!input) return null;
  const plain = input.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length > 0 ? plain : null;
}

function truncate(input: string | null, max = 500): string | null {
  if (!input) return null;
  return input.length > max ? `${input.slice(0, max)}...` : input;
}

function normalizeSchedule(rawItems: EduScheduleItem[]): NormalizedScheduleItem[] {
  return rawItems.map((item) => ({
    startsAt: item.godzinaOd ?? null,
    endsAt: item.godzinaDo ?? null,
    subject: item.przedmiot ?? null,
    teacher: item.prowadzacy ?? null,
    room: item.sala ?? null,
    raw: item,
  }));
}

function normalizeGrades(rawItems: EduGradeItem[]): NormalizedGradeItem[] {
  return rawItems.map((item) => ({
    subject: item.przedmiot ?? null,
    grade: item.ocena ?? null,
    date: item.data ?? null,
    category: item.kategoria ?? null,
    raw: item,
  }));
}

function mapMessageToStudent(studentName: string, allMessages: EduMessageListItem[]): EduMessageListItem[] {
  const tokens = studentName
    .toLowerCase()
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  return allMessages
    .filter((message) => tokens.some((token) => message.skrzynka.toLowerCase().includes(token)))
    .filter((message) => new Date(message.data) >= sevenDaysAgo)
    .filter((message) => !message.przeczytana)
    .slice(0, 10);
}

async function apiGetJson<T>(url: string, headers: Record<string, string>, failureCode: number): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new CliError(`API request failed for ${url}: ${response.status} ${response.statusText}`, failureCode);
  }
  return (await response.json()) as T;
}

async function saveDebugScreenshot(page: Page, debugDir: string | undefined, label: string): Promise<string | undefined> {
  if (!debugDir) return undefined;

  await mkdir(debugDir, { recursive: true });
  const filePath = join(debugDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

async function loginAndGetRegion(page: Page, username: string, password: string): Promise<string> {
  await page.goto(LOGIN_URL);
  await page.waitForLoadState('domcontentloaded');
  await sleep(1_000);

  try {
    const cookieFrame = page.frameLocator('#respect-privacy-frame');
    await cookieFrame.locator('button:has-text("Zgadzam się")').click({ timeout: 5_000 });
    await sleep(1_500);
  } catch {
    // no popup or already dismissed
  }

  const emailInput = page.locator('input[name="Login"], input[placeholder="Login"], input[type="text"]').first();
  await emailInput.waitFor({ state: 'visible', timeout: 8_000 });
  await emailInput.fill(username);

  await page.locator('button:has-text("Dalej"), button:has-text("Next")').first().click();
  await sleep(2_000);

  const passwordInput = page.locator('input[type="password"], input[name="Haslo"]').first();
  await passwordInput.waitFor({ state: 'visible', timeout: 8_000 });
  await passwordInput.fill(password);
  await page.locator('button:has-text("Zaloguj")').first().click();

  await page.waitForLoadState('domcontentloaded');
  await sleep(3_000);

  let currentUrl = page.url();
  if (currentUrl.includes('logowanie') || currentUrl.includes('eduvulcan.pl/Account')) {
    await sleep(3_000);
    currentUrl = page.url();
  }

  if (!currentUrl.includes('uczen.eduvulcan.pl')) {
    const selectedBy = await clickFirstAvailable(page, [
      'a.connected-account',
      'a[href^="/dziennik?"]',
      'a.connected-account:has-text("(SP")',
      'a[href*="uczen.eduvulcan.pl"]',
      'button:has-text("Wybierz"), button:has-text("Przejdź")',
      '[data-testid*="student"]',
      '[class*="student"]',
      '[class*="card"]',
    ], 5_000);

    if (!selectedBy) {
      throw new CliError('Could not find student card after login.', EXIT_CODES.LOGIN_OR_NAVIGATION);
    }

    await page.waitForLoadState('domcontentloaded');
    await sleep(5_000);
    currentUrl = page.url();

    try {
      const cookieFrame = page.frameLocator('#respect-privacy-frame');
      await cookieFrame.locator('button:has-text("Zgadzam się")').click({ timeout: 3_000 });
      await sleep(1_000);
    } catch {
      // ignore
    }
  }

  if (!currentUrl.includes('uczen.eduvulcan.pl')) {
    throw new CliError(`Failed to reach the student portal. Current URL: ${currentUrl}`, EXIT_CODES.LOGIN_OR_NAVIGATION);
  }

  const match = currentUrl.match(/https:\/\/uczen\.eduvulcan\.pl\/([^/]+)/);
  if (!match) {
    throw new CliError(`Could not determine EduVulcan region from URL: ${currentUrl}`, EXIT_CODES.LOGIN_OR_NAVIGATION);
  }

  return match[1];
}

async function fetchStudentRecords(
  page: Page,
  context: BrowserContext,
  region: string,
  warnings: string[],
): Promise<NormalizedStudentRecord[]> {
  const apiBase = `https://uczen.eduvulcan.pl/${region}/api`;
  const headers = {
    Cookie: toCookieHeader(await context.cookies()),
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  };

  const contextData = await apiGetJson<ContextResponse>(`${apiBase}/Context`, headers, EXIT_CODES.API_FETCH);
  const students = contextData.uczniowie.filter((student) => student.aktywny);

  let allMessages: EduMessageListItem[] = [];
  let messageHeaders = headers;
  const messagesApiBase = `https://wiadomosci.eduvulcan.pl/${region}/api`;

  try {
    await clickFirstAvailable(page, [
      'a[href*="wiadomosci"]',
      'text=Wiadomości',
      'button:has-text("Wiadomości")',
    ], 5_000);
    await page.waitForLoadState('networkidle');
    await sleep(2_000);

    messageHeaders = {
      ...headers,
      Cookie: toCookieHeader(await context.cookies()),
    };

    const received = await fetch(`${messagesApiBase}/Odebrane?idLastWiadomosc=0&pageSize=50`, {
      headers: messageHeaders,
    });

    if (received.ok) {
      const payload = await received.json();
      allMessages = Array.isArray(payload) ? (payload as EduMessageListItem[]) : [];
    } else {
      warnings.push(`Messages list request returned ${received.status} ${received.statusText}`);
    }
  } catch (error) {
    warnings.push(`Messages fetch bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const today = new Date();
  const endDate = new Date(today.getFullYear(), today.getMonth() + 2, 0, 23, 59, 59, 999);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 1);

  const start = encodeURIComponent(startDate.toISOString());
  const end = encodeURIComponent(endDate.toISOString());

  const records: NormalizedStudentRecord[] = [];

  for (const student of students) {
    const schedulePromise = fetch(`${apiBase}/PlanZajecTablica?key=${student.key}`, { headers });
    const gradesPromise = fetch(`${apiBase}/OcenyTablica?key=${student.key}`, { headers });
    const homeworkListPromise = fetch(
      `${apiBase}/SprawdzianyZadaniaDomowe?key=${student.key}&dataOd=${start}&dataDo=${end}`,
      { headers },
    );

    const [scheduleRes, gradesRes, homeworkListRes] = await Promise.all([schedulePromise, gradesPromise, homeworkListPromise]);

    const rawSchedule = scheduleRes.ok ? ((await scheduleRes.json()) as EduScheduleItem[]) : [];
    if (!scheduleRes.ok) {
      warnings.push(`Schedule request failed for ${student.uczen}: ${scheduleRes.status} ${scheduleRes.statusText}`);
    }

    const rawGrades = gradesRes.ok ? ((await gradesRes.json()) as EduGradeItem[]) : [];
    if (!gradesRes.ok) {
      warnings.push(`Grades request failed for ${student.uczen}: ${gradesRes.status} ${gradesRes.statusText}`);
    }

    const homeworkList = homeworkListRes.ok ? ((await homeworkListRes.json()) as EduHomeworkListItem[]) : [];
    if (!homeworkListRes.ok) {
      warnings.push(`Homework list request failed for ${student.uczen}: ${homeworkListRes.status} ${homeworkListRes.statusText}`);
    }

    const homework: NormalizedHomeworkItem[] = [];
    for (const item of homeworkList) {
      try {
        const detailResponse = await fetch(`${apiBase}/ZadanieDomoweSzczegoly?key=${student.key}&id=${item.id}`, { headers });
        const detail = detailResponse.ok ? ((await detailResponse.json()) as EduHomeworkDetail) : undefined;
        if (!detailResponse.ok) {
          warnings.push(`Homework details request failed for ${student.uczen} item ${item.id}: ${detailResponse.status} ${detailResponse.statusText}`);
        }
        homework.push({
          type: item.typ,
          subject: item.przedmiotNazwa,
          date: item.data ?? null,
          description: stripHtml(detail?.opis),
          teacher: detail?.nauczycielImieNazwisko ?? null,
          dueAt: detail?.terminOdpowiedzi ?? null,
        });
      } catch (error) {
        warnings.push(`Homework details fetch failed for ${student.uczen} item ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
        homework.push({
          type: item.typ,
          subject: item.przedmiotNazwa,
          date: item.data ?? null,
          description: null,
          teacher: null,
          dueAt: null,
        });
      }
    }

    const mappedMessages = mapMessageToStudent(student.uczen, allMessages);
    const messages: NormalizedMessageItem[] = [];

    for (const message of mappedMessages) {
      try {
        const detailResponse = await fetch(
          `${messagesApiBase}/WiadomoscSzczegoly?apiGlobalKey=${message.apiGlobalKey}`,
          { headers: messageHeaders },
        );
        const detail = detailResponse.ok ? ((await detailResponse.json()) as EduMessageDetail) : undefined;
        if (!detailResponse.ok) {
          warnings.push(`Message details request failed for ${student.uczen} message ${message.apiGlobalKey}: ${detailResponse.status} ${detailResponse.statusText}`);
        }
        messages.push({
          id: message.apiGlobalKey,
          sender: message.korespondenci.split(' - ')[0] ?? null,
          subject: message.temat ?? null,
          date: message.data ?? null,
          unread: !message.przeczytana,
          body: truncate(stripHtml(detail?.tresc)),
        });
      } catch (error) {
        warnings.push(`Message details fetch failed for ${student.uczen} message ${message.apiGlobalKey}: ${error instanceof Error ? error.message : String(error)}`);
        messages.push({
          id: message.apiGlobalKey,
          sender: message.korespondenci.split(' - ')[0] ?? null,
          subject: message.temat ?? null,
          date: message.data ?? null,
          unread: !message.przeczytana,
          body: null,
        });
      }
    }

    records.push({
      studentKey: student.key,
      name: student.uczen,
      className: student.oddzial ?? null,
      school: student.jednostka ?? null,
      schedule: normalizeSchedule(Array.isArray(rawSchedule) ? rawSchedule : []),
      grades: normalizeGrades(Array.isArray(rawGrades) ? rawGrades : []),
      homework,
      messages,
    });
  }

  return records;
}

export async function fetchSnapshot(options: {
  username: string;
  password: string;
  headless: boolean;
  debugDir?: string;
}): Promise<NormalizedSnapshot> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const { browser, context, page } = await launchBrowser(options.headless);

  try {
    const region = await loginAndGetRegion(page, options.username, options.password);
    const students = await fetchStudentRecords(page, context, region, warnings);

    return {
      fetchedAt: new Date().toISOString(),
      source: 'eduvulcan',
      status: warnings.length > 0 ? 'partial' : 'ok',
      students,
      meta: {
        region,
        durationMs: Date.now() - startedAt,
        version: VERSION,
        warnings,
      },
    };
  } catch (error) {
    const screenshotPath = await saveDebugScreenshot(page, options.debugDir, 'failure').catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    const detail = screenshotPath ? `${reason} Debug screenshot: ${screenshotPath}` : reason;

    if (error instanceof CliError) {
      throw new CliError(detail, error.exitCode);
    }

    throw new CliError(detail, EXIT_CODES.UNEXPECTED);
  } finally {
    await browser.close().catch(async (error) => {
      const logDir = options.debugDir ? dirname(options.debugDir) : process.cwd();
      await mkdir(logDir, { recursive: true }).catch(() => undefined);
      await writeFile(join(logDir, 'browser-close-error.log'), String(error)).catch(() => undefined);
    });
  }
}
