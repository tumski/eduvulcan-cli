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
  FetchProfile,
  NormalizedFreeDayItem,
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
const VERSION = '0.2.0';
const DEFAULT_TIMEZONE = process.env.TZ || 'Europe/Warsaw';

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

function normalizeFreeDays(rawItems: Record<string, unknown>[]): NormalizedFreeDayItem[] {
  return rawItems.map((item) => ({
    date: typeof item.data === 'string' ? item.data : typeof item.date === 'string' ? item.date : null,
    title: typeof item.nazwa === 'string' ? item.nazwa : typeof item.tytul === 'string' ? item.tytul : null,
    description: typeof item.opis === 'string' ? item.opis : null,
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

function resolveTargetDate(input: string | undefined, timezone: string): string {
  if (!input || input === 'today') {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  if (input === 'tomorrow') {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(tomorrow);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new CliError(`Invalid --date value: ${input}. Use today, tomorrow, or YYYY-MM-DD.`, EXIT_CODES.UNEXPECTED);
  }

  return input;
}

function getOffsetForDate(date: string, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const probe = new Date(`${date}T12:00:00.000Z`);
  const offsetPart = formatter.formatToParts(probe).find((part) => part.type === 'timeZoneName')?.value;
  if (!offsetPart) {
    throw new CliError(`Could not determine timezone offset for ${date} in ${timezone}`, EXIT_CODES.UNEXPECTED);
  }
  return offsetPart.replace('GMT', '');
}

function buildDateRange(date: string, timezone: string): { from: string; to: string } {
  const offset = getOffsetForDate(date, timezone);
  const from = new Date(`${date}T00:00:00.000${offset}`).toISOString();
  const to = new Date(`${date}T23:59:59.999${offset}`).toISOString();
  return { from, to };
}

async function apiGetJson<T>(url: string, headers: Record<string, string>, failureCode: number): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new CliError(`API request failed for ${url}: ${response.status} ${response.statusText}`, failureCode);
  }
  return (await response.json()) as T;
}

async function safeApiJson<T>(url: string, headers: Record<string, string>, warnings: string[], label: string): Promise<T | undefined> {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      warnings.push(`${label} request failed: ${response.status} ${response.statusText}`);
      return undefined;
    }
    return (await response.json()) as T;
  } catch (error) {
    warnings.push(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
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

async function fetchRecentMessages(
  page: Page,
  context: BrowserContext,
  region: string,
  baseHeaders: Record<string, string>,
  warnings: string[],
): Promise<{ allMessages: EduMessageListItem[]; messageHeaders: Record<string, string> }> {
  const messagesApiBase = `https://wiadomosci.eduvulcan.pl/${region}/api`;
  let allMessages: EduMessageListItem[] = [];
  let messageHeaders = baseHeaders;

  try {
    await clickFirstAvailable(page, [
      'a[href*="wiadomosci"]',
      'text=Wiadomości',
      'button:has-text("Wiadomości")',
    ], 5_000);
    await page.waitForLoadState('networkidle');
    await sleep(2_000);

    messageHeaders = {
      ...baseHeaders,
      Cookie: toCookieHeader(await context.cookies()),
    };

    const payload = await safeApiJson<EduMessageListItem[]>(
      `${messagesApiBase}/Odebrane?idLastWiadomosc=0&pageSize=50`,
      messageHeaders,
      warnings,
      'Messages list',
    );
    allMessages = Array.isArray(payload) ? payload : [];
  } catch (error) {
    warnings.push(`Messages fetch bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { allMessages, messageHeaders };
}

async function fetchStudentRecords(options: {
  page: Page;
  context: BrowserContext;
  region: string;
  targetDate: string;
  timezone: string;
  profile: FetchProfile;
  warnings: string[];
}): Promise<NormalizedStudentRecord[]> {
  const { page, context, region, targetDate, timezone, profile, warnings } = options;
  const apiBase = `https://uczen.eduvulcan.pl/${region}/api`;
  const { from, to } = buildDateRange(targetDate, timezone);
  const encodedFrom = encodeURIComponent(from);
  const encodedTo = encodeURIComponent(to);

  const headers = {
    Cookie: toCookieHeader(await context.cookies()),
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  };

  const contextData = await apiGetJson<ContextResponse>(`${apiBase}/Context`, headers, EXIT_CODES.API_FETCH);
  const students = contextData.uczniowie.filter((student) => student.aktywny);
  const { allMessages, messageHeaders } = await fetchRecentMessages(page, context, region, headers, warnings);
  const messagesApiBase = `https://wiadomosci.eduvulcan.pl/${region}/api`;

  const records: NormalizedStudentRecord[] = [];

  for (const student of students) {
    const schedulePromise = safeApiJson<EduScheduleItem[]>(
      `${apiBase}/PlanZajec?key=${student.key}&dataOd=${encodedFrom}&dataDo=${encodedTo}&zakresDanych=2`,
      headers,
      warnings,
      `Schedule for ${student.uczen}`,
    );
    const homeworkListPromise = safeApiJson<EduHomeworkListItem[]>(
      `${apiBase}/SprawdzianyZadaniaDomowe?key=${student.key}&dataOd=${encodedFrom}&dataDo=${encodedTo}`,
      headers,
      warnings,
      `Homework list for ${student.uczen}`,
    );
    const freeDaysPromise = safeApiJson<Record<string, unknown>[]>(
      `${apiBase}/DniWolne?key=${student.key}&dataOd=${encodedFrom}&dataDo=${encodedTo}`,
      headers,
      warnings,
      `Free days for ${student.uczen}`,
    );

    const gradesPromise = profile === 'comprehensive'
      ? safeApiJson<EduGradeItem[]>(`${apiBase}/OcenyTablica?key=${student.key}`, headers, warnings, `Grades for ${student.uczen}`)
      : Promise.resolve(undefined);
    const announcementsPromise = profile === 'comprehensive'
      ? safeApiJson<Record<string, unknown>[]>(`${apiBase}/OgloszeniaTablica?key=${student.key}`, headers, warnings, `Announcements for ${student.uczen}`)
      : Promise.resolve(undefined);
    const infoCardsPromise = profile === 'comprehensive'
      ? safeApiJson<Record<string, unknown>[]>(`${apiBase}/InformacjeTablica?key=${student.key}`, headers, warnings, `Info cards for ${student.uczen}`)
      : Promise.resolve(undefined);

    const [rawSchedule, homeworkList, rawFreeDays, rawGrades, rawAnnouncements, rawInfoCards] = await Promise.all([
      schedulePromise,
      homeworkListPromise,
      freeDaysPromise,
      gradesPromise,
      announcementsPromise,
      infoCardsPromise,
    ]);

    const homework: NormalizedHomeworkItem[] = [];
    for (const item of Array.isArray(homeworkList) ? homeworkList : []) {
      try {
        const detailResponse = await fetch(`${apiBase}/ZadanieDomoweSzczegoly?key=${student.key}&id=${item.id}`, { headers });
        const detail = detailResponse.ok ? ((await detailResponse.json()) as EduHomeworkDetail) : undefined;
        if (!detailResponse.ok) {
          warnings.push(`Homework details request failed for ${student.uczen} item ${item.id}: ${detailResponse.status} ${detailResponse.statusText}`);
        }
        homework.push({
          id: item.id,
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
          id: item.id,
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
      homework,
      messages,
      freeDays: normalizeFreeDays(Array.isArray(rawFreeDays) ? rawFreeDays : []),
      extended: profile === 'comprehensive'
        ? {
            announcements: Array.isArray(rawAnnouncements) ? rawAnnouncements : [],
            infoCards: Array.isArray(rawInfoCards) ? rawInfoCards : [],
            grades: normalizeGrades(Array.isArray(rawGrades) ? rawGrades : []),
          }
        : undefined,
    });
  }

  return records;
}

export async function fetchSnapshot(options: {
  username: string;
  password: string;
  headless: boolean;
  debugDir?: string;
  targetDate?: string;
  timezone?: string;
  profile?: FetchProfile;
}): Promise<NormalizedSnapshot> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const timezone = options.timezone || DEFAULT_TIMEZONE;
  const targetDate = resolveTargetDate(options.targetDate, timezone);
  const { from, to } = buildDateRange(targetDate, timezone);
  const profile = options.profile || 'standard';
  const { browser, context, page } = await launchBrowser(options.headless);

  try {
    const region = await loginAndGetRegion(page, options.username, options.password);
    const students = await fetchStudentRecords({
      page,
      context,
      region,
      targetDate,
      timezone,
      profile,
      warnings,
    });

    return {
      fetchedAt: new Date().toISOString(),
      source: 'eduvulcan',
      status: warnings.length > 0 ? 'partial' : 'ok',
      targetDate,
      dateRange: {
        from,
        to,
        timezone,
      },
      profile,
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
