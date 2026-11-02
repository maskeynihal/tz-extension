/**
 * The project's website. The world clock lives there rather than in the
 * extension: one copy of a full-page app to maintain, and a link the user can
 * keep open in a tab, bookmark or share. The extension's popup opens these.
 */
export const SITE_ORIGIN = 'https://tz.nihal.com.np';

/** The full-page world clock. */
export const SITE_CLOCK_URL = `${SITE_ORIGIN}/clock`;

/** The online converter, the same engine the popup runs. */
export const SITE_CONVERTER_URL = `${SITE_ORIGIN}/app`;
