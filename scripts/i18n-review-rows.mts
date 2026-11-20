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

// A sample for each parameter name used by the message functions.
const SAMPLE_VALUES: Record<string, unknown> = {
  maxLength: 50,
  min: 1,
  max: 720,
  minutes: 12,
  hours: 1,
  seconds: 42,
  digits: 6,
  count: 8,
  players: 12,
  courts: "3",
  courtNumber: "2",
  team: "A",
  player: 1,
  startTime: "18:00",
  name: "Linh Tran",
  firstName: "Linh",
  lastName: "Tran",
  hostName: "Mai",
  displayName: "Mai Le",
  email: "mai@example.com",
  sessionName: "Saturday Social",
  draftName: "Saturday Social",
  socialName: "Riverside Pickleball",
  courtName: "Court 2",
  courtNames: "Court 1, Court 2",
  shortLink: "pickle.example/t/ab12cd",
  description: "Adding Linh Tran",
  message: "Check your connection and retry.",
};

/** "(firstName: string, lastName: string) => …" → ["firstName", "lastName"] */
function parameterNames(messageFunction: (...values: never[]) => string) {
  const parameters = /^\(([^)]*)\)/.exec(messageFunction.toString())?.[1];
  return (parameters ?? "")
    .split(",")
    .map((parameter) => parameter.trim().split(/[\s:=]/)[0])
    .filter(Boolean);
}

type Tree = { [key: string]: unknown };
const rows: Array<{ key: string; en: string; vi: string }> = [];

function sample(key: string, value: unknown, path: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "function") {
    const values = parameterNames(value as () => string).map((parameter) => {
      if (!(parameter in SAMPLE_VALUES))
        throw new Error(`No sample for "${parameter}" at ${path}`);
      return SAMPLE_VALUES[parameter];
    });
    return String((value as (...values: unknown[]) => string)(...values));
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
