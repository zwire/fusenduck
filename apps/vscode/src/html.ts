// The webview's page: apps/web/spa/index.html (copied into dist by build.ts), with the Web UI's CSP
// (docs/adr/0002) rewritten for a webview. Scripts load only with this page's nonce, styles and
// images only from the extension's own files, and nothing may be fetched: the page reaches core by
// messages to the extension host.

export interface PageOptions {
  /** index.html as the Web UI serves it. */
  template: string;
  /** webview.cspSource: the origin the webview serves the extension's files from. */
  cspSource: string;
  /** A fresh random value for each page. */
  nonce: string;
  /** Webview URIs of the files in dist. */
  script: string;
  styles: string[];
}

export function csp(cspSource: string, nonce: string): string {
  return (
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource}; img-src ${cspSource}; ` +
    "connect-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'"
  );
}

const attr = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** Swaps one tag of the template, failing loudly if the Web UI's page no longer has it. */
function swap(html: string, tag: RegExp, replacement: string): string {
  if (!tag.test(html)) throw new Error(`the Web UI page has changed: ${tag} not found in index.html`);
  return html.replace(tag, () => replacement);
}

export function webviewPage(options: PageOptions): string {
  let html = swap(options.template, /<html lang="en">/, '<html lang="en" data-host="vscode">');
  // The CSP goes first in <head>, so it covers everything the page loads.
  html = swap(html, /<head>/, `<head>\n    <meta http-equiv="Content-Security-Policy" content="${attr(csp(options.cspSource, options.nonce))}" />`);
  html = swap(
    html,
    /<link rel="stylesheet" href="style.css" \/>/,
    options.styles.map((href) => `<link rel="stylesheet" href="${attr(href)}" />`).join("\n    "),
  );
  return swap(html, /<script type="module" src="app.js"><\/script>/, `<script type="module" nonce="${attr(options.nonce)}" src="${attr(options.script)}"></script>`);
}
