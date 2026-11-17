// The window's static DOM (spec 06e § 2): the sections the modules fill. Shared by the window and the preview.
const SKELETON = `
<main id="tray" class="tray">
  <section id="header" class="card header">
    <div class="header-top">
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <rect x="2" y="3" width="18" height="4" rx="1.5"></rect>
          <rect x="2" y="9" width="18" height="4" rx="1.5" opacity="0.75"></rect>
          <rect x="2" y="15" width="18" height="4" rx="1.5" opacity="0.5"></rect>
        </svg>
        <span>Fornax</span>
      </div>
      <span id="status" class="pill" data-tone="off"><span class="pill-dot"></span><span id="status-label">Stopped</span></span>
    </div>
    <div class="header-row">
      <span id="status-line" class="status-line"></span>
      <div class="header-buttons">
        <button id="pause" type="button" data-key="pause" disabled>Pause queue</button>
        <button id="worker" type="button" class="outline go" data-key="worker" disabled>Start worker</button>
      </div>
    </div>
    <p id="server" class="banner banner-error" hidden></p>
    <p id="note" class="banner banner-error" hidden></p>
    <p id="pause-error" class="banner banner-error" hidden></p>
    <div id="update" class="banner banner-update" hidden>
      <p id="update-text"></p>
      <div class="banner-buttons">
        <button id="update-button" type="button" class="accent" data-key="update"></button>
        <button id="cancel-update" type="button" data-key="cancel-update">Cancel update</button>
      </div>
      <p id="update-note" class="banner-note" hidden></p>
    </div>
  </section>
  <section id="gpu" class="card gpu" data-tone="normal"></section>
  <section class="block queue">
    <h2 class="label">Running</h2>
    <div id="running"></div>
  </section>
  <section class="block queue waiting-block">
    <div class="label-row"><h2 id="waiting-title" class="label">Waiting</h2><span id="waiting-note" class="label-note"></span></div>
    <ol id="waiting" class="list waiting-list"></ol>
  </section>
  <section id="idle-block" class="block queue waiting-block idle-block" hidden>
    <div class="label-row"><h2 id="idle-title" class="label">Idle</h2><button id="start-idle" type="button" class="small go" data-key="start-idle">▶ Start all</button></div>
    <p id="start-idle-error" class="action-error" hidden></p>
    <ol id="idle" class="list waiting-list"></ol>
  </section>
  <section class="card tabs">
    <div id="tablist" class="tablist" role="tablist">
      <button id="tab-history" class="tab" type="button" role="tab" aria-controls="panel-history" data-key="tab-history">History</button>
      <button id="tab-log" class="tab" type="button" role="tab" aria-controls="panel-log" data-key="tab-log">Worker log</button>
    </div>
    <div id="panel-history" class="panel queue" role="tabpanel" aria-labelledby="tab-history"><ol id="history" class="list"></ol></div>
    <div id="panel-log" class="panel log-panel" role="tabpanel" aria-labelledby="tab-log" hidden><ol id="log" class="log"></ol></div>
  </section>
  <footer class="footer">
    <div id="types" class="types"></div>
    <p id="type-reason" class="type-reason" hidden></p>
    <p id="versions" class="versions"></p>
  </footer>
</main>
<div id="quit" class="overlay" hidden>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="quit-text">
    <p id="quit-text">Stop the worker and quit? The running job goes back to the queue.</p>
    <div class="dialog-buttons">
      <button id="quit-no" type="button" data-key="quit-no">Keep running</button>
      <button id="quit-yes" type="button" class="quit" data-key="quit-yes">Quit</button>
    </div>
  </div>
</div>`;

export function mountSkeleton(root: HTMLElement): void {
  root.innerHTML = SKELETON;
}
