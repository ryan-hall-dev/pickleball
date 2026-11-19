// Prints every interface line as {key, en, vi} JSON, with sample values in the
// placeholders, for the native-speaker review page (docs/plans/bilingual-ui.md).
// Run: pnpm i18n-review-rows > rows.json
// Imported by runtime path: Node strips the types; tsc can't follow ".ts" here.
const messagesDirectory = "../src/i18n/messages";
const { en } = (await import(
  `${messagesDirectory}/en.ts`
)) as typeof import("../src/i18n/messages/en");
const { vi } = (await import(
  `${messagesDirectory}/vi.ts`
)) as typeof import("../src/i18n/messages/vi");

const SAMPLE_ARGUMENTS: Record<string, unknown[]> = {
  nameTooLong: [50],
  minutesLeft: [80],
  sessionMinutes: [120],
  minutes: [120],
  startedEndUnavailable: ["18:00"],
  welcomeHeading: ["Riverside Pickleball"],
  sent: ["Saturday Social"],
  checkedInTo: ["Saturday Social"],
  "checkin.alreadyCheckedIn.title": ["Saturday Social"],
  nothingMore: ["Linh"],
};

type Tree = { [key: string]: unknown };
const rows: Array<{ key: string; en: string; vi: string }> = [];

function sample(key: string, value: unknown, path: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "function") {
    const values = SAMPLE_ARGUMENTS[path] ?? SAMPLE_ARGUMENTS[key] ?? ["Linh"];
    return String(value(...values));
  }
  throw new Error(`Unexpected message at ${path}`);
}

function walk(english: Tree, vietnamese: Tree, prefix: string) {
  for (const key of Object.keys(english)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const englishValue = english[key];
    const vietnameseValue = vietnamese[key];
    if (typeof englishValue === "object" && englishValue !== null) {
      walk(englishValue as Tree, vietnameseValue as Tree, path);
    } else {
      rows.push({
        key: path,
        en: sample(key, englishValue, path),
        vi: sample(key, vietnameseValue, path),
      });
    }
  }
}

walk(en as Tree, vi as Tree, "");
console.log(JSON.stringify(rows, null, 2));
