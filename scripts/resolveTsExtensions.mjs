// Lets plain Node run the app's TypeScript message files, whose relative
// imports have no extension (as Next and tsc expect): tries ".ts" when a
// relative import can't be found. Used by `pnpm i18n-review-rows`.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || /\.[cm]?[jt]s$/.test(specifier))
        throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});
