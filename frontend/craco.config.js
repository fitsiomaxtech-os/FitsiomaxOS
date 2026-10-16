// craco.config.js
const path = require("path");
const { execSync } = require("child_process");
require("dotenv").config();

// The build the login page's version label names, read from git when the app is built or
// the dev server starts — the deploy pulls and restarts on every push, so this is the code
// that is actually live. Total commits make the build number: it only ever goes up, and
// one number identifies exactly one state of the code. Any git failure (no .git, git not
// installed, a repo owned by another user) leaves these blank and the label falls back
// to the plain version rather than stopping the app from starting.
const git = (args) => {
  try {
    return execSync(`git ${args}`, { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
};
process.env.REACT_APP_BUILD_NUMBER = process.env.REACT_APP_BUILD_NUMBER || git("rev-list --count HEAD");
process.env.REACT_APP_BUILD_COMMIT = process.env.REACT_APP_BUILD_COMMIT || git("rev-parse --short=8 HEAD");
process.env.REACT_APP_BUILD_DATE = process.env.REACT_APP_BUILD_DATE || git("log -1 --format=%cs");

// Check if we're in development/preview mode (not production build)
// Craco sets NODE_ENV=development for start, NODE_ENV=production for build
const isDevServer = process.env.NODE_ENV !== "production";

// Environment variable overrides
const config = {
  enableHealthCheck: process.env.ENABLE_HEALTH_CHECK === "true",
};

// Conditionally load health check modules only if enabled
let WebpackHealthPlugin;
let setupHealthEndpoints;
let healthPluginInstance;

if (config.enableHealthCheck) {
  WebpackHealthPlugin = require("./plugins/health-check/webpack-health-plugin");
  setupHealthEndpoints = require("./plugins/health-check/health-endpoints");
  healthPluginInstance = new WebpackHealthPlugin();
}

let webpackConfig = {
  eslint: {
    configure: {
      extends: ["plugin:react-hooks/recommended"],
      rules: {
        "react-hooks/rules-of-hooks": "error",
        "react-hooks/exhaustive-deps": "warn",
        // A const is not hoisted the way a function declaration is. Reading one above its
        // declaration throws "Cannot access X before initialization" the moment the module
        // is evaluated -- not when the code runs, but at import, which takes down every
        // page importing the file rather than the one feature that got it wrong.
        //
        // An error, not a warning: the failure is total and the fix is to move one line.
        // Functions stay exempt, since a hoisted declaration really is safe to call above
        // where it is written, and flagging those would bury this in noise.
        "no-use-before-define": ["error", { variables: true, functions: false, classes: true }],
        // The sibling failure: a name that is never bound at all. It throws while React
        // renders -- "from is not defined" took the Zumba tab down when a date filter was
        // rewritten and the old names were left behind in a dependency array, where
        // nothing reads them but the engine still evaluates them.
        //
        // exhaustive-deps stays a warning on purpose. It is the rule that would have caught
        // that array before the names went stale, but there are hooks all over this app
        // with deliberately partial deps, several with a disable comment already; promoting
        // it would fail the build on all of them at once rather than on the one bug.
        "no-undef": "error",
      },
    },
  },
  webpack: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
    configure: (webpackConfig) => {

      // Add ignored patterns to reduce watched directories
        webpackConfig.watchOptions = {
          ...webpackConfig.watchOptions,
          ignored: [
            '**/node_modules/**',
            '**/.git/**',
            '**/build/**',
            '**/dist/**',
            '**/coverage/**',
            '**/public/**',
        ],
      };

      // Add health check plugin to webpack if enabled
      if (config.enableHealthCheck && healthPluginInstance) {
        webpackConfig.plugins.push(healthPluginInstance);
      }
      return webpackConfig;
    },
  },
};

webpackConfig.devServer = (devServerConfig) => {
  // Add health check endpoints if enabled
  if (config.enableHealthCheck && setupHealthEndpoints && healthPluginInstance) {
    const originalSetupMiddlewares = devServerConfig.setupMiddlewares;

    devServerConfig.setupMiddlewares = (middlewares, devServer) => {
      // Call original setup if exists
      if (originalSetupMiddlewares) {
        middlewares = originalSetupMiddlewares(middlewares, devServer);
      }

      // Setup health endpoints
      setupHealthEndpoints(devServer, healthPluginInstance);

      return middlewares;
    };
  }

  return devServerConfig;
};

// Wrap with visual edits (automatically adds babel plugin, dev server, and overlay in dev mode)
if (isDevServer) {
  try {
    const { withVisualEdits } = require("@emergentbase/visual-edits/craco");
    webpackConfig = withVisualEdits(webpackConfig);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && err.message.includes('@emergentbase/visual-edits/craco')) {
      console.warn(
        "[visual-edits] @emergentbase/visual-edits not installed — visual editing disabled."
      );
    } else {
      throw err;
    }
  }
}

module.exports = webpackConfig;
