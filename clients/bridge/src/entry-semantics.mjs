import { pathToFileURL } from 'node:url';

/**
 * Decide whether a module is being invoked as the process entry point.
 *
 * Esbuild's CommonJS output provides `require` and `module`, while native
 * ESM provides a module URL that can be compared to the invoked script URL.
 */
export function isCliEntry({ require: cjsRequire, module: cjsModule, metaUrl, argvHref } = {}) {
  if (cjsRequire && cjsModule) return cjsRequire.main === cjsModule;
  return !!metaUrl && argvHref === metaUrl;
}

export function resolveCliEntry({ metaUrl, argv } = {}) {
  const argvHref = argv?.[1] ? pathToFileURL(argv[1]).href : undefined;
  return isCliEntry({ metaUrl, argvHref });
}
