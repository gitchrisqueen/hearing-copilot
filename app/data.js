// This file is served DYNAMICALLY by web-server.py from the selected hearing profile:
//   hearing-copilot/hearings/<HEARING>/data.js     (pick with:  ./launch.command <profile>)
//
// When launched through launch.command, a request for /app/data.js returns the ACTIVE
// profile's window.CASE (rebuttals, objections, binder, hearingConfig, ...). This physical
// file is only a fallback for opening the app without the server; it intentionally defines
// no case so a missing/misconfigured server is obvious in the UI and console.
window.CASE = window.CASE || {
  title: "(no hearing profile loaded — launch via ./launch.command <profile>)",
  hearingConfig: {}, parties: {}, priority: {}, linchpins: [], traps: [], powerPhrases: [],
  anchorPhrases: [], emphasize: [],
  docPaths: {}, defendantsTabs: [], plaintiffTabs: [], rebuttals: [], objections: [],
  preservationTail: ""
};
console.warn("[data.js] Static stub served. Launch via ./launch.command <profile> so web-server.py serves hearings/<HEARING>/data.js.");
