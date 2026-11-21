// Light / dark theme (docs/plans/light-mode.md). Light is the default; a host
// can choose dark with ThemeSwitch, saved in this browser only.

export const THEME_STORAGE_KEY = "pickleball-theme";
export const THEME_CHANGE_EVENT = "pickleball-theme-change";

/**
 * Runs inline in <head> before the first paint, so a dark choice never
 * flashes light. The player check-in page (/t/...) is always light.
 * Storage can throw (private windows): then light.
 */
export const THEME_BOOT_SCRIPT = `(function(){var theme="light";try{if(location.pathname.indexOf("/t/")!==0&&localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})==="dark")theme="dark"}catch(error){}document.documentElement.dataset.theme=theme})();`;
