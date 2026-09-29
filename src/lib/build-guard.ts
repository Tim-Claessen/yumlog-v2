// Build-time data guard for the static recipe pages.
//
// Every recipe page is pre-rendered from Supabase at build time. If the build
// can't read the data — wrong PUBLIC_SUPABASE_* build variables, the `yumlog`
// schema missing from the Data API's exposed schemas, or missing grants — the
// queries return an error or zero rows, and without this guard an empty site
// would deploy "successfully". Throwing fails `astro build`; Workers Builds
// only runs the deploy step after a successful build, so the last good site
// stays live instead.

const LIKELY_CAUSES =
  'Likely causes: the PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY build variables point at the ' +
  'wrong project or are missing; "yumlog" is not in Supabase → Data API → Exposed schemas; or anon ' +
  'lacks SELECT on yumlog.* (db/002_yumlog_security.sql).';

/** Throw with a message that says what failed and where to look. */
export function failBuild(what: string, error?: { message?: string } | null): never {
  const detail = error?.message ? ` Supabase said: ${error.message}.` : '';
  throw new Error(`Build stopped — ${what}.${detail} Refusing to deploy an empty or partial site. ${LIKELY_CAUSES}`);
}
