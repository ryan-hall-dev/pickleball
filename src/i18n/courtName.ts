import type { Messages } from "./messages";

const GENERATED_COURT_NAME = /^Court (\d+)$/;

/**
 * Setup names courts "Court 1", "Court 2"… and the name is stored in the
 * session. Those generated names follow the chosen language; any other name
 * stays exactly as entered.
 */
export function courtName(storedName: string, messages: Messages): string {
  const match = GENERATED_COURT_NAME.exec(storedName);
  return match ? messages.host.live.court.numbered(match[1]) : storedName;
}
