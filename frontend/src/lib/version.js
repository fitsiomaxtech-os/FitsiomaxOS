// The OS version shown on the login page.
//
// 3 is the generation — v1, v2, then the v3 system that is live now (the same v3 as the
// API). The .0 moves only when a release is called for. The build number and the rest come
// from git at build time (see craco.config.js) and move on their own with every deploy.
export const APP_VERSION = "3.0";

const BUILD_NUMBER = process.env.REACT_APP_BUILD_NUMBER || "";
const BUILD_COMMIT = process.env.REACT_APP_BUILD_COMMIT || "";
const BUILD_DATE = process.env.REACT_APP_BUILD_DATE || ""; // YYYY-MM-DD

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const prettyDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : "";
};

export const versionLabel = BUILD_NUMBER ? `Version ${APP_VERSION} · Build ${BUILD_NUMBER}` : `Version ${APP_VERSION}`;

// The hover text: which day and which commit, for whoever has to match a report to code.
export const versionDetail = [BUILD_DATE && `Updated ${prettyDate(BUILD_DATE)}`, BUILD_COMMIT]
  .filter(Boolean)
  .join(" · ");
