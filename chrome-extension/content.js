(() => {
  if (window.__gnomeoReviewLayerInjected) return;
  window.__gnomeoReviewLayerInjected = true;

  const host = document.createElement('div');
  host.id = 'gnomeo-review-layer-host';
  host.setAttribute('aria-live', 'polite');
  host.style.all = 'initial';
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '2147483647';

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap {
        position: fixed;
        inset: 0;
        pointer-events: none;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .button {
        position: fixed;
        right: 18px;
        bottom: 18px;
        pointer-events: auto;
        border: 1px solid rgba(15, 23, 42, 0.12);
        background: rgba(248, 250, 252, 0.96);
        color: #0f172a;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
        border-radius: 999px;
        padding: 10px 14px;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: -0.01em;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .button::before {
        content: '';
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #64748b;
        display: inline-block;
      }
      .panel-shell {
        position: fixed;
        top: 16px;
        right: 16px;
        bottom: 16px;
        width: min(420px, calc(100vw - 32px));
        pointer-events: auto;
        transform: translateX(110%);
        transition: transform 180ms ease;
        border-radius: 20px;
        overflow: hidden;
        box-shadow: 0 24px 60px rgba(15, 23, 42, 0.20);
        border: 1px solid rgba(15, 23, 42, 0.12);
        background: #fff;
      }
      .panel-shell[data-open='true'] { transform: translateX(0); }
      .panel-frame {
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
        background: #fff;
      }
      @media (max-width: 640px) {
        .panel-shell { left: 12px; right: 12px; width: auto; top: 12px; bottom: 12px; }
      }
    </style>
    <div class="wrap">
      <button class="button" type="button" aria-controls="gnomeo-review-panel" aria-expanded="false">Review with Gnomeo</button>
      <div class="panel-shell" id="gnomeo-review-panel" data-open="false" aria-hidden="true">
        <iframe class="panel-frame" title="Gnomeo review panel" src="${chrome.runtime.getURL('panel.html')}"></iframe>
      </div>
    </div>
  `;

  document.documentElement.appendChild(host);

  const button = shadow.querySelector('.button');
  const panel = shadow.querySelector('.panel-shell');
  const setOpen = (open) => {
    panel.dataset.open = open ? 'true' : 'false';
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  button.addEventListener('click', () => {
    setOpen(panel.dataset.open !== 'true');
  });

  window.addEventListener('message', (event) => {
    if (event.source !== panel.querySelector('iframe')?.contentWindow) return;
    if (!event.data || event.data.type !== 'gnomeo-close') return;
    setOpen(false);
  });
})();
