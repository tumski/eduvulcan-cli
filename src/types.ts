export const EXIT_CODES = {
  SUCCESS: 0,
  MISSING_CREDENTIALS: 10,
  BROWSER_INIT: 11,
  LOGIN_OR_NAVIGATION: 12,
  API_FETCH: 13,
  OUTPUT_WRITE: 14,
  UNEXPECTED: 15,
} as const;

export type FetchProfile = 'standard' | 'comprehensive';

export interface StudentContext {
  key: string;
  uczen: string;
  oddzial: string;
  jednostka: string;
  idDziennik: number;
  aktywny: boolean;
}

export interface ContextResponse {
  uczniowie: StudentContext[];
}

export interface EduScheduleItem {
  godzinaOd?: string;
  godzinaDo?: string;
  przedmiot?: string;
  prowadzacy?: string;
  sala?: string;
  data?: string;
  [key: string]: unknown;
}

export interface EduGradeItem {
  przedmiot?: string;
  ocena?: string;
  data?: string;
  kategoria?: string;
  komentarz?: string;
  [key: string]: unknown;
}

export interface EduHomeworkListItem {
  typ: number;
  przedmiotNazwa: string;
  data: string;
  hasAttachment?: boolean;
  id: number;
}

export interface EduHomeworkDetail {
  opis?: string;
  nauczycielImieNazwisko?: string;
  terminOdpowiedzi?: string;
  [key: string]: unknown;
}

export interface EduMessageListItem {
  apiGlobalKey: string;
  korespondenci: string;
  temat: string;
  data: string;
  skrzynka: string;
  przeczytana: boolean;
  hasZalaczniki?: boolean;
}

export interface EduMessageDetail {
  tresc?: string;
  [key: string]: unknown;
}

export interface NormalizedScheduleItem {
  startsAt: string | null;
  endsAt: string | null;
  subject: string | null;
  teacher: string | null;
  room: string | null;
  raw: EduScheduleItem;
}

export interface NormalizedGradeItem {
  subject: string | null;
  grade: string | null;
  date: string | null;
  category: string | null;
  raw: EduGradeItem;
}

export interface NormalizedHomeworkItem {
  id?: number;
  type: number;
  subject: string;
  date: string | null;
  description: string | null;
  teacher: string | null;
  dueAt: string | null;
}

export interface NormalizedMessageItem {
  id: string;
  sender: string | null;
  subject: string | null;
  date: string | null;
  unread: boolean;
  body: string | null;
}

export interface NormalizedFreeDayItem {
  date: string | null;
  title: string | null;
  description: string | null;
  raw: Record<string, unknown>;
}

export interface NormalizedExtendedStudentData {
  announcements?: Record<string, unknown>[];
  infoCards?: Record<string, unknown>[];
  grades?: NormalizedGradeItem[];
}

export interface NormalizedStudentRecord {
  studentKey: string;
  name: string;
  className: string | null;
  school: string | null;
  schedule: NormalizedScheduleItem[];
  homework: NormalizedHomeworkItem[];
  messages: NormalizedMessageItem[];
  freeDays: NormalizedFreeDayItem[];
  extended?: NormalizedExtendedStudentData;
}

export interface NormalizedSnapshot {
  fetchedAt: string;
  source: 'eduvulcan';
  status: 'ok' | 'partial';
  targetDate: string;
  dateRange: {
    from: string;
    to: string;
    timezone: string;
  };
  profile: FetchProfile;
  students: NormalizedStudentRecord[];
  meta: {
    region: string;
    durationMs: number;
    version: string;
    warnings: string[];
  };
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
