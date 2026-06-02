(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DebugReport = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function buildDebugReport({ appVersion, generatedAt, recipe, result, error, lines, proxyLog }) {
    const failed = Boolean(error);
    const env = recipe?.environment || {};
    const event = recipe?.event || {};
    const verificationError = result?.verification?.error || '';

    const header = [
      'mkEvent debug report',
      `Generated: ${generatedAt || '(unknown)'}`,
      `App version: ${appVersion || '(unknown)'}`,
      `Environment: ${env.id || '(unknown)'} (${env.baseUrl || 'n/a'})`,
      `Status: ${failed ? 'failed' : 'success'}`,
      `Event: ${event.name || 'Untitled event'} / keyword ${event.slug || '(none)'} / id ${result?.eventId || '—'}`,
      `Admin URL: ${result?.adminUrl || '(unavailable)'}`,
      `Public URL: ${result?.publicUrl || '(unavailable)'}`,
      `Bidders: ${recipe?.bidders?.count ?? '?'}   Items: ${recipe?.items?.count ?? '?'}`,
    ];
    if (failed) header.push(`Error: ${error}`);
    header.push(`Verification: ${verificationError ? `FAILED — ${verificationError}` : 'OK'}`);

    const transcriptLines = Array.isArray(lines) ? lines : [];
    const transcript = [
      '',
      `=== UI transcript (${transcriptLines.length} lines) ===`,
      ...transcriptLines.map(l => `${l.ts || '--:--:--'} [${l.kind || 'info'}/${l.tag || ''}] ${l.msg || ''}`),
    ];

    let proxySection;
    if (proxyLog && Array.isArray(proxyLog.lines) && proxyLog.lines.length) {
      proxySection = [
        '',
        `=== Proxy log (last ${proxyLog.lines.length}) ===`,
        ...proxyLog.lines,
      ];
    } else if (proxyLog && Array.isArray(proxyLog.lines)) {
      proxySection = ['', '=== Proxy log: empty (no entries yet) ==='];
    } else {
      const reason = (proxyLog && proxyLog.error) || 'proxy unreachable';
      proxySection = ['', `=== Proxy log: UNAVAILABLE (${reason}) ===`];
    }

    return [...header, ...transcript, ...proxySection].join('\n');
  }

  return { buildDebugReport };
});
