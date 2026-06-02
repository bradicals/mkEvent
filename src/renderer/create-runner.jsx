// CreateRunner — real API-backed ClickBid V4 flow for the QA event creator.
// Streams logs from CreationEngine.createEvent() and surfaces the actual result.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CreationEngine from '../shared/creation-engine.js';
import EventModel from '../shared/event-model.js';
import DebugReport from '../shared/debug-report.js';

export function RunModal({ config, recipe, onClose }) {
  const [lines, setLines] = useState([]);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('running');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [copyState, setCopyState] = useState('idle');
  const [reportState, setReportState] = useState('idle');
  const bodyRef = useRef(null);
  const hasStartedRef = useRef(false);
  const activeRef = useRef(true);

  const appendLine = useCallback((entry) => {
    setLines(prev => [
      ...prev,
      { ...entry, ts: new Date().toLocaleTimeString([], { hour12: false }) },
    ]);
  }, []);

  useEffect(() => {
    // Re-arm on every (re)mount so a StrictMode unmount/remount cycle doesn't
    // leave the surviving run() permanently flagged inactive.
    activeRef.current = true;
    if (hasStartedRef.current) return undefined;
    hasStartedRef.current = true;

    const run = async () => {
      setStatus('running');
      setProgress(0);
      setResult(null);
      setError('');
      setCopyState('idle');
      setReportState('idle');
      setLines([]);

      try {
        const created = await CreationEngine.createEvent(config, recipe, {
          onLog(entry) {
            if (!activeRef.current) return;
            appendLine(entry);
          },
          onProgress(percent) {
            if (!activeRef.current) return;
            setProgress(percent);
          },
        });

        if (!activeRef.current) return;
        setResult(created);
        setError('');
        setStatus('success');
        setProgress(100);
      } catch (runError) {
        if (!activeRef.current) return;
        const message = runError?.message || 'Unknown creation error';
        appendLine({ kind: 'error', tag: 'fatal', msg: message });
        setError(message);
        setStatus('error');
      }
    };

    run();
    return () => { activeRef.current = false; };
  }, [appendLine, config, recipe]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines, result, error]);

  const isRunning = status === 'running';
  const isSuccess = status === 'success';
  const isError = status === 'error';
  const isKeywordConflict = isError && /keyword .* already in use/i.test(error);
  const title = isSuccess
    ? 'Event created'
    : isKeywordConflict
      ? 'Event keyword already in use'
      : isError
        ? 'Event creation failed'
        : 'Creating event…';
  const verificationError = result?.verification?.error || '';

  const footerText = isSuccess
    ? `${result?.eventId || 'event created'} · ${result?.publicUrl || recipe.environment.baseUrl}`
    : isError
      ? `Failed in ${recipe.environment.id}: ${error}`
      : `Working… ${progress}%`;

  const copyPayload = useMemo(() => {
    const verificationSummary = verificationError
      ? `Verification: FAILED — ${verificationError}`
      : 'Verification: OK';

    return [
      `Environment: ${recipe.environment.id}`,
      `Event name: ${recipe.event.name || 'Untitled event'}`,
      `Event keyword: ${recipe.event.slug}`,
      `Event ID: ${result?.eventId || '(not created)'}`,
      `Admin URL: ${result?.adminUrl || '(unavailable)'}`,
      `Public URL: ${result?.publicUrl || '(unavailable)'}`,
      `Bidders: ${recipe.bidders.count}`,
      `Items: ${recipe.items.count}`,
      verificationSummary,
    ].join('\n');
  }, [recipe, result, verificationError]);

  const copySummary = async () => {
    try {
      if (!navigator?.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(copyPayload);
      setCopyState('copied');
    } catch (copyError) {
      setCopyState('failed');
      window.alert(`Could not copy summary: ${copyError.message}`);
    }
  };

  const copyDebugReport = async () => {
    let proxyLog = null;
    try {
      const url = EventModel.proxyToolUrl(config.api.proxyUrl, '/debug/logs?lines=500');
      const resp = await fetch(url, { method: 'GET' });
      if (resp.ok) {
        proxyLog = await resp.json();
      } else {
        proxyLog = { error: `proxy returned ${resp.status}` };
      }
    } catch (fetchError) {
      proxyLog = { error: fetchError?.message || 'proxy unreachable' };
    }

    const report = DebugReport.buildDebugReport({
      appVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      recipe,
      result,
      error,
      lines,
      proxyLog,
    });

    try {
      if (!navigator?.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(report);
      setReportState('copied');
    } catch (copyError) {
      setReportState('failed');
      window.alert(`Could not copy debug report: ${copyError.message}`);
    }
  };

  const renderIcon = (kind) => {
    if (kind === 'ok') return <i className="fa-solid fa-check"></i>;
    if (kind === 'run') return <i className="fa-solid fa-circle-notch fa-spin"></i>;
    if (kind === 'error') return <i className="fa-solid fa-triangle-exclamation"></i>;
    return <i className="fa-solid fa-circle-info"></i>;
  };

  return (
    <div className="run-overlay">
      <div className="run-modal" role="dialog" aria-label="Creating event">
        <div className="run-head">
          <div className="traffic"><span></span><span></span><span></span></div>
          <div className="title">{title}</div>
          <div className="sub">{recipe.environment.id} · API-first</div>
        </div>
        <div className="run-progress"><div className="bar" style={{ width: `${progress}%` }}></div></div>
        <div className="run-body" ref={bodyRef}>
          {lines.map((l, i) => (
            <div key={`${l.ts}-${l.tag}-${i}`} className={`run-line ${l.kind}`}>
              <span className="ts">{l.ts}</span>
              <span className="ico">{renderIcon(l.kind)}</span>
              <span className="msg"><span className="tag">{l.tag}</span>{l.msg}</span>
            </div>
          ))}

          {(isSuccess || isError) && (
            <div className={`run-result ${isError ? 'is-error' : ''}`}>
              <div className="run-result-head">
                <div className="run-result-title">{isError ? 'Run outcome' : 'Created event summary'}</div>
                <div className="run-result-sub">
                  {isKeywordConflict
                    ? `The keyword "${recipe.event.slug}" is already taken in this ClickBid environment. Close this modal, change the Event keyword in Event Details, and run Create again.`
                    : isError
                      ? 'The modal stayed open so QA can review the failure.'
                      : 'Use these exact values for QA verification and handoff.'}
                </div>
              </div>
              <div className="run-result-grid">
                <div className="run-result-card">
                  <label>Status</label>
                  <div>{isError ? 'Failed' : verificationError ? 'Created with verification warning' : 'Created and verified'}</div>
                </div>
                <div className="run-result-card">
                  <label>Environment</label>
                  <div>{recipe.environment.id}</div>
                </div>
                <div className="run-result-card">
                  <label>Keyword</label>
                  <div>{recipe.event.slug}</div>
                </div>
                <div className="run-result-card">
                  <label>Event ID</label>
                  <div>{result?.eventId || 'Unavailable'}</div>
                </div>
                <div className="run-result-card run-result-card-wide">
                  <label>Admin URL</label>
                  <div>{result?.adminUrl || 'Unavailable'}</div>
                </div>
                <div className="run-result-card run-result-card-wide">
                  <label>Public URL</label>
                  <div>{result?.publicUrl || 'Unavailable'}</div>
                </div>
                <div className="run-result-card">
                  <label>Bidders</label>
                  <div>{recipe.bidders.count}</div>
                </div>
                <div className="run-result-card">
                  <label>Items</label>
                  <div>{recipe.items.count}</div>
                </div>
                <div className="run-result-card run-result-card-wide">
                  <label>Verification</label>
                  <div>{isError ? error : verificationError || 'Counts verified by the creation engine.'}</div>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="run-foot">
          <div className="left">{footerText}</div>
          {isRunning ? (
            <>
              <button className="btn btn-outline" onClick={onClose}>Close</button>
              <button className="btn btn-outline" onClick={copyDebugReport} title="Copy a full debug report (UI log + proxy log) to send for troubleshooting">
                <i className="fa-solid fa-bug"></i> {reportState === 'copied' ? 'Copied' : 'Copy debug report'}
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-outline" onClick={onClose}>Close</button>
              <button className="btn btn-outline" onClick={copyDebugReport} title="Copy a full debug report (UI log + proxy log) to send for troubleshooting">
                <i className="fa-solid fa-bug"></i> {reportState === 'copied' ? 'Copied' : 'Copy debug report'}
              </button>
              <button className="btn btn-primary" onClick={copySummary} disabled={!isSuccess} title={isSuccess ? 'Copy created event summary' : 'Copy is only available after a successful create'}>
                <i className="fa-regular fa-copy"></i> {copyState === 'copied' ? 'Copied' : 'Copy summary'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
