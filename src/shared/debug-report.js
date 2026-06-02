import '../../debug-report.js';

const DebugReport = globalThis.DebugReport;

if (!DebugReport) {
  throw new Error('DebugReport failed to initialize from legacy module.');
}

export default DebugReport;
