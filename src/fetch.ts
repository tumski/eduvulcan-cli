import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { APIRequestContext, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import {
  completeWsFedChain,
  orderJournalHandoffs,
  type HttpClient,
  type HttpResponseLike,
} from './wsfed.js';
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
const VERSION = '0.3.0';
const DEFAULT_TIMEZONE = process.env.TZ || 'Europe/Warsaw';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

type PageEvaluator = Pick<Page, 'evaluate'>;

interface BrowserJsonResult<T> {
  ok: boolean;
  status: number;
  statusText: string;
  data?: T;
}

export async function fetchJsonInPage<T>(page: PageEvaluator, url: string, headers: Record<string, string>): Promise<BrowserJsonResult<T>> {
  return page.evaluate(async ({ requestUrl, requestHeaders }) => {
    const response = await fetch(requestUrl, {
      method: 'GET',
      headers: requestHeaders,
      credentials: 'include',
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        statusText: response.statusText,
      };
    }

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      data: (await response.json()) as T,
    };
  }, { requestUrl: url, requestHeaders: headers });
}

function withHeaders(client: HttpClient, headers: Record<string, string>): HttpClient {
  return {
    request(url, init) {
      return client.request(url, {
        ...init,
        headers: { ...headers, ...init.headers },
      });
    },
  };
}

function diaryApiHeaders(region: string): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://uczen.eduvulcan.pl',
    Referer: `https://uczen.eduvulcan.pl/${region}/App`,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

function messagesApiHeaders(region: string): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://wiadomosci.eduvulcan.pl',
    Referer: `https://wiadomosci.eduvulcan.pl/${region}/App`,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

function asHttpClient(request: APIRequestContext): HttpClient {
  return {
    async request(url, init): Promise<HttpResponseLike> {
      const options = {
        headers: init.headers,
        form: init.form,
        maxRedirects: 20,
        failOnStatusCode: false,
      };
      const response = init.method === 'POST'
        ? await request.post(url, options)
        : await request.get(url, options);
      return {
        url: response.url(),
        status: response.status(),
        headers: response.headers(),
        text: () => response.text(),
      };
    },
  };
}

function summarizeBody(body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (!compact) return 'empty response';
  if (compact.startsWith('{') || compact.startsWith('[')) return compact.slice(0, 180);
  if (/Strona nie została odnaleziona/i.test(compact)) return 'Strona nie została odnaleziona';
  if (/Brak uprawnień/i.test(compact)) return 'Brak uprawnień';
  return 'HTML response';
}

async function readJson<T>(client: HttpClient, url: string): Promise<BrowserJsonResult<T>> {
  const response = await client.request(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const body = await response.text();
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      status: response.status,
      statusText: summarizeBody(body),
    };
  }

  try {
    return {
      ok: true,
      status: response.status,
      statusText: 'OK',
      data: JSON.parse(body) as T,
    };
  } catch {
    return {
      ok: false,
      status: response.status,
      statusText: summarizeBody(body),
    };
  }
}

async function apiGetJson<T>(client: HttpClient, url: string, failureCode: number): Promise<T> {
  const response = await readJson<T>(client, url);
  if (!response.ok || response.data === undefined) {
    throw new CliError(`API request failed for ${url}: ${response.status} ${response.statusText}`, failureCode);
  }
  return response.data;
}

async function safeApiJson<T>(client: HttpClient, url: string, warnings: string[], label: string): Promise<T | undefined> {
  try {
    const response = await readJson<T>(client, url);
    if (!response.ok) {
      warnings.push(`${label} request failed: ${response.status} ${response.statusText}`);
      return undefined;
    }
    return response.data as T;
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

const JOURNAL_PICKER_URL = 'https://eduvulcan.pl/dostep-do-dziennika/';

async function dismissCookieBanner(page: Page, timeoutMs: number): Promise<void> {
  try {
    const cookieFrame = page.frameLocator('#respect-privacy-frame');
    await cookieFrame.locator('button:has-text("Zgadzam się"), button:has-text("Akceptuję")').first().click({ timeout: timeoutMs });
    await sleep(500);
  } catch {
    // no popup or already dismissed
  }
}

async function dismissJournalOverlays(page: Page): Promise<void> {
  for (const selector of ['.vdpo-tutorial-tooltip__close', '.vdpo-journal-shortcut__close']) {
    try {
      await page.locator(selector).first().click({ timeout: 1_500 });
    } catch {
      // overlay not present
    }
  }
}

async function loginParentPortal(page: Page, username: string, password: string): Promise<void> {
  await page.goto(LOGIN_URL);
  await page.waitForLoadState('domcontentloaded');
  await dismissCookieBanner(page, 5_000);

  const emailInput = page.locator('#UserName, input[name="UserName"], input[name="Login"], input[type="text"]').first();
  await emailInput.waitFor({ state: 'visible', timeout: 8_000 });
  await emailInput.fill(username);

  const userInfo = page.waitForResponse(
    (response) => response.url().includes('/Account/QueryUserInfo'),
    { timeout: 8_000 },
  ).catch(() => undefined);
  await page.locator('#btNext, button:has-text("Dalej"), button:has-text("Next")').first().click();

  const passwordInput = page.locator('#Password, input[type="password"], input[name="Haslo"]').first();
  await passwordInput.waitFor({ state: 'visible', timeout: 8_000 });
  await passwordInput.fill(password);
  await userInfo;
  await sleep(300);

  const captcha = page.locator('#captcha');
  if (await captcha.isVisible().catch(() => false)) {
    await page.locator('#captcha-success-wrapper.active').waitFor({ timeout: 25_000 }).catch(() => undefined);
  }

  await page.locator('#btLogOn, button:has-text("Zaloguj")').first().click();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForURL((url) => !url.pathname.toLowerCase().includes('logowanie'), { timeout: 20_000 }).catch(() => undefined);
}

async function collectJournalHandoffs(page: Page): Promise<string[]> {
  await dismissJournalOverlays(page);
  await page.locator('a[href*="/dziennik"], a[href*="uczen.eduvulcan.pl"]').first().waitFor({ timeout: 12_000 }).catch(() => undefined);
  const hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).href));
  return orderJournalHandoffs(hrefs);
}

async function openJournalPicker(page: Page): Promise<string[]> {
  let links = await collectJournalHandoffs(page);
  if (links.length > 0) return links;

  await page.goto(JOURNAL_PICKER_URL, { waitUntil: 'domcontentloaded' });
  await dismissCookieBanner(page, 3_000);
  links = await collectJournalHandoffs(page);
  return links;
}

async function establishPortalSession(page: Page, request: APIRequestContext, username: string, password: string): Promise<{ region: string; client: HttpClient }> {
  await loginParentPortal(page, username, password);
  const client = asHttpClient(request);
  const links = await openJournalPicker(page);

  if (links.length === 0) {
    throw new CliError(
      `Could not find a journal handoff link after login. Current URL: ${page.url()}`,
      EXIT_CODES.LOGIN_OR_NAVIGATION,
    );
  }

  const failures: string[] = [];
  for (const link of links) {
    try {
      const chain = await completeWsFedChain(client, link);
      const region = chain.region;
      if (!region) {
        failures.push(`${link} ended at ${chain.finalUrl} (${chain.status}) without a tenant`);
        continue;
      }

      const contextUrl = `https://uczen.eduvulcan.pl/${region}/api/Context`;
      const probe = await readJson<ContextResponse>(withHeaders(client, diaryApiHeaders(region)), contextUrl);
      const students = probe.ok && probe.data && Array.isArray(probe.data.uczniowie) ? probe.data.uczniowie : null;
      if (students) {
        return { region, client };
      }

      const landing = chain.notFound ? ' landing page was not found;' : '';
      failures.push(`Context for ${region} returned ${probe.status} ${probe.statusText};${landing} final URL ${chain.finalUrl}`);
    } catch (error) {
      failures.push(`${link} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new CliError(
    `Student portal handoff did not reach Context. ${failures.join(' | ')}`,
    EXIT_CODES.API_FETCH,
  );
}

async function fetchRecentMessages(
  client: HttpClient,
  region: string,
  warnings: string[],
): Promise<EduMessageListItem[]> {
  const messagesApiBase = `https://wiadomosci.eduvulcan.pl/${region}/api`;

  try {
    const chain = await completeWsFedChain(client, `https://wiadomosci.eduvulcan.pl/${region}/App`);
    if (chain.notFound) {
      warnings.push(`Messages inbox landing page was not found (${chain.status} ${chain.finalUrl}).`);
    }
  } catch (error) {
    warnings.push(`Messages inbox SSO failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }

  const payload = await safeApiJson<EduMessageListItem[]>(
    withHeaders(client, messagesApiHeaders(region)),
    `${messagesApiBase}/Odebrane?idLastWiadomosc=0&pageSize=50`,
    warnings,
    'Messages list',
  );
  return Array.isArray(payload) ? payload : [];
}

async function fetchStudentRecords(options: {
  client: HttpClient;
  region: string;
  targetDate: string;
  timezone: string;
  profile: FetchProfile;
  warnings: string[];
}): Promise<NormalizedStudentRecord[]> {
  const { client: rawClient, region, targetDate, timezone, profile, warnings } = options;
  const client = withHeaders(rawClient, diaryApiHeaders(region));
  const apiBase = `https://uczen.eduvulcan.pl/${region}/api`;
  const { from, to } = buildDateRange(targetDate, timezone);
  const encodedFrom = encodeURIComponent(from);
  const encodedTo = encodeURIComponent(to);

  const contextData = await apiGetJson<ContextResponse>(client, `${apiBase}/Context`, EXIT_CODES.API_FETCH);
  const students = contextData.uczniowie.filter((student) => student.aktywny);

  const records: NormalizedStudentRecord[] = [];

  for (const student of students) {
    const schedulePromise = safeApiJson<EduScheduleItem[]>(
      client,
      `${apiBase}/PlanZajec?key=${student.key}&dataOd=${encodedFrom}&dataDo=${encodedTo}&zakresDanych=2`,
      warnings,
      `Schedule for ${student.uczen}`,
    );
    const homeworkListPromise = safeApiJson<EduHomeworkListItem[]>(
      client,
      `${apiBase}/SprawdzianyZadaniaDomowe?key=${student.key}&dataOd=${encodedFrom}&dataDo=${encodedTo}`,
      warnings,
      `Homework list for ${student.uczen}`,
    );
    const freeDaysPromise = safeApiJson<Record<string, unknown>[]>(
      client,
      `${apiBase}/DniWolne?key=${student.key}&dataOd=${encodedFrom}&dataDo=${encodedTo}`,
      warnings,
      `Free days for ${student.uczen}`,
    );

    const gradesPromise = profile === 'comprehensive'
      ? safeApiJson<EduGradeItem[]>(client, `${apiBase}/OcenyTablica?key=${student.key}`, warnings, `Grades for ${student.uczen}`)
      : Promise.resolve(undefined);
    const announcementsPromise = profile === 'comprehensive'
      ? safeApiJson<Record<string, unknown>[]>(client, `${apiBase}/OgloszeniaTablica?key=${student.key}`, warnings, `Announcements for ${student.uczen}`)
      : Promise.resolve(undefined);
    const infoCardsPromise = profile === 'comprehensive'
      ? safeApiJson<Record<string, unknown>[]>(client, `${apiBase}/InformacjeTablica?key=${student.key}`, warnings, `Info cards for ${student.uczen}`)
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
        const detailResponse = await readJson<EduHomeworkDetail>(
          client,
          `${apiBase}/ZadanieDomoweSzczegoly?key=${student.key}&id=${item.id}`,
        );
        const detail = detailResponse.ok ? detailResponse.data : undefined;
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

    records.push({
      studentKey: student.key,
      name: student.uczen,
      className: student.oddzial ?? null,
      school: student.jednostka ?? null,
      schedule: normalizeSchedule(Array.isArray(rawSchedule) ? rawSchedule : []),
      homework,
      messages: [],
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

  const allMessages = await fetchRecentMessages(rawClient, region, warnings);
  const messagesClient = withHeaders(rawClient, messagesApiHeaders(region));
  const messagesApiBase = `https://wiadomosci.eduvulcan.pl/${region}/api`;

  for (const record of records) {
    const mappedMessages = mapMessageToStudent(record.name, allMessages);
    const messages: NormalizedMessageItem[] = [];

    for (const message of mappedMessages) {
      try {
        const detailResponse = await readJson<EduMessageDetail>(
          messagesClient,
          `${messagesApiBase}/WiadomoscSzczegoly?apiGlobalKey=${message.apiGlobalKey}`,
        );
        const detail = detailResponse.ok ? detailResponse.data : undefined;
        if (!detailResponse.ok) {
          warnings.push(`Message details request failed for ${record.name} message ${message.apiGlobalKey}: ${detailResponse.status} ${detailResponse.statusText}`);
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
        warnings.push(`Message details fetch failed for ${record.name} message ${message.apiGlobalKey}: ${error instanceof Error ? error.message : String(error)}`);
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

    record.messages = messages;
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
    const { region, client } = await establishPortalSession(page, context.request, options.username, options.password);
    const students = await fetchStudentRecords({
      client,
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
