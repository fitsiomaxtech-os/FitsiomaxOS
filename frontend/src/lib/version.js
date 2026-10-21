// The OS version shown on the login page: MAJOR.FEATURE.FIX, e.g. 3.1.4.
//
//   MAJOR    3 is the generation — v1, v2, then the v3 system that is live now (the same
//            v3 as the API). Moves only when the clinic asks for it.
//   FEATURE  Moves by hand when a push adds a feature or screen: raise it here and set
//            FEATURE_STARTED_AT_BUILD to the commit count that push will have
//            (`git rev-list --count HEAD`, plus one for the commit being made).
//   FIX      Not written anywhere. It is the number of commits since the feature number
//            last moved, so every push raises it without anybody remembering to.
//
// The build number, date and commit come from git at build time (see craco.config.js).
const MAJOR_FEATURE = "3.6";
const FEATURE_STARTED_AT_BUILD = 2615; // the commit that started 3.6, shown as 3.6.1

const BUILD_NUMBER = process.env.REACT_APP_BUILD_NUMBER || "";
const BUILD_COMMIT = process.env.REACT_APP_BUILD_COMMIT || "";
const BUILD_DATE = process.env.REACT_APP_BUILD_DATE || ""; // YYYY-MM-DD

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const prettyDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : "";
};

// Without git (or on a checkout older than the feature it names) there is no honest fix
// number, so the label stops at the two parts it does know.
const fix = Number(BUILD_NUMBER) - FEATURE_STARTED_AT_BUILD + 1;
export const APP_VERSION = fix >= 1 ? `${MAJOR_FEATURE}.${fix}` : MAJOR_FEATURE;

export const versionLabel = `Version ${APP_VERSION}`;

// The hover text: which build, day and commit, for whoever has to match a report to code.
export const versionDetail = [
  BUILD_NUMBER && `Build ${BUILD_NUMBER}`,
  BUILD_DATE && `Updated ${prettyDate(BUILD_DATE)}`,
  BUILD_COMMIT,
]
  .filter(Boolean)
  .join(" · ");
