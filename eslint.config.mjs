export default [
  {
    ignores: ["node_modules/**", "vendor/**"],
  },
  {
    files: ["static/**/*.js", "tests/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-constant-binary-expression": "error",
      "no-debugger": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // index.html loads these as classic scripts that share window.Zak* globals.
    // Only service-switcher.js is an ES module.
    files: [
      "static/platform.js",
      "static/app.js",
      "static/library.js",
      "static/reader.js",
    ],
    languageOptions: {
      sourceType: "script",
    },
  },
];
