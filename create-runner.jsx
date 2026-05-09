// CreateRunner — simulated API-first ClickBid V4 flow for the QA event creator.
// Uses the generated recipe and shows the exact kind of progress QA needs.

window.RunModal = function RunModal({ config, recipe, summary, onClose }) {
  const [lines, setLines] = React.useState([]);
  const [progress, setProgress] = React.useState(0);
  const [done, setDone] = React.useState(false);
  const bodyRef = React.useRef(null);

  React.useEffect(() => {
    const eventId = 'evt_' + Math.random().toString(36).slice(2, 10);
    const org = recipe.environment.organizationId || '{organization}';
    const base = recipe.environment.apiBaseUrl || 'https://cbodev4.com/api/v4';
    const plan = [
      { kind: 'info', tag: 'init', msg: `Loading ${recipe.environment.id} environment settings` },
      { kind: 'info', tag: 'api', msg: `Base URL ${base}` },
      { kind: 'run', tag: 'event', msg: `POST /organizations/${org}/events — creating "${recipe.event.name || 'Untitled event'}"` },
      { kind: 'ok', tag: 'event', msg: `event.id = ${eventId}; slug = ${recipe.event.slug}` },
      { kind: 'run', tag: 'event', msg: `Applying schedule ${recipe.event.startDate || '(no start date)'} ${recipe.event.startTime || ''} → ${recipe.event.endDate || '(no end date)'} ${recipe.event.endTime || ''} ${recipe.event.timezone}` },
      { kind: 'ok', tag: 'event', msg: 'Event basics saved through organization-scoped API.' },
      { kind: 'run', tag: 'bidders', msg: `Bulk creating ${recipe.bidders.count} bidders starting at #${config.bidders.startNum}` },
      { kind: 'ok', tag: 'bidders', msg: `${recipe.bidders.count} bidder records ready with deterministic names and emails.` },
      { kind: 'run', tag: 'items', msg: `Bulk creating ${recipe.items.count} items: ${summary.itemBreakdown.silent} silent, ${summary.itemBreakdown.live} live, ${summary.itemBreakdown.donation} donation` },
      { kind: 'ok', tag: 'items', msg: `${recipe.items.count} item records ready with type IDs 10/20/30 as applicable.` },
      { kind: 'info', tag: 'defaults', msg: 'Landing page and customer-facing pages left on ClickBid defaults.' },
      { kind: 'run', tag: 'verify', msg: `GET /events/${eventId}?with=bidders,items — verifying generated counts` },
      { kind: 'ok', tag: 'verify', msg: `Verified ${recipe.bidders.count} bidders and ${recipe.items.count} items in ${recipe.environment.id}.` },
      { kind: 'ok', tag: 'done', msg: `Event ready: ${summary.publicUrl}` },
    ];

    let i = 0;
    let timerId;
    const tick = () => {
      if (i >= plan.length) { setDone(true); setProgress(100); return; }
      const step = plan[i];
      if (!step) { setDone(true); setProgress(100); return; }
      setLines(prev => [...prev, { ...step, ts: new Date().toLocaleTimeString([], { hour12: false }) }]);
      setProgress(Math.round(((i + 1) / plan.length) * 100));
      i++;
      timerId = setTimeout(tick, step.kind === 'ok' ? 280 : 420);
    };
    tick();
    return () => clearTimeout(timerId);
  }, []);

  React.useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines]);

  return (
    <div className="run-overlay">
      <div className="run-modal" role="dialog" aria-label="Creating event">
        <div className="run-head">
          <div className="traffic"><span></span><span></span><span></span></div>
          <div className="title">{done ? 'Event created' : 'Creating event…'}</div>
          <div className="sub">{recipe.environment.id} · API-first</div>
        </div>
        <div className="run-progress"><div className="bar" style={{ width: progress + '%' }}></div></div>
        <div className="run-body" ref={bodyRef}>
          {lines.map((l, i) => (
            <div key={i} className={`run-line ${l.kind}`}>
              <span className="ts">{l.ts}</span>
              <span className="ico">
                {l.kind === 'ok' ? <i className="fa-solid fa-check"></i> :
                 l.kind === 'run' ? <i className="fa-solid fa-circle-notch fa-spin"></i> :
                 <i className="fa-solid fa-circle-info"></i>}
              </span>
              <span className="msg"><span className="tag">{l.tag}</span>{l.msg}</span>
            </div>
          ))}
        </div>
        <div className="run-foot">
          <div className="left">{done ? `${summary.adminUrl} · ${summary.publicUrl}` : `Working… ${progress}%`}</div>
          {done ? (
            <>
              <button className="btn btn-outline" onClick={onClose}>Close</button>
              <button className="btn btn-primary"><i className="fa-regular fa-copy"></i> Copy summary</button>
            </>
          ) : (
            <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          )}
        </div>
      </div>
    </div>
  );
};
