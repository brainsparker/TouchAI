/**
 * The script injected into the recorded window.
 *
 * It draws a cursor, a click ring, and a caption inside the webview so the
 * recording shows intent without the app knowing anything about the preview. It
 * also keeps the console errors the checks report.
 */

export const OVERLAY_SCRIPT = String.raw`
(() => {
  if (window.__UI_PREVIEW__) {
    return;
  }

  const errors = [];
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    errors.push(args.map((value) => String(value)).join(' ').slice(0, 500));
    originalError(...args);
  };
  window.addEventListener('error', (event) => {
    errors.push(String(event.message || 'window error').slice(0, 500));
  });
  window.addEventListener('unhandledrejection', (event) => {
    errors.push(String(event.reason || 'unhandled rejection').slice(0, 500));
  });

  const layer = document.createElement('div');
  layer.id = '__ui_preview_overlay';
  layer.style.cssText = [
    'position:fixed',
    'inset:0',
    'pointer-events:none',
    'z-index:2147483647',
    'overflow:hidden',
  ].join(';');

  const cursor = document.createElement('div');
  cursor.style.cssText = [
    'position:absolute',
    'width:18px',
    'height:18px',
    'border-radius:50%',
    'background:rgba(255,255,255,0.92)',
    'border:2px solid rgba(20,20,20,0.75)',
    'box-shadow:0 2px 6px rgba(0,0,0,0.35)',
    'transform:translate(-50%,-50%)',
    'transition:left 220ms ease,top 220ms ease',
    'left:-100px',
    'top:-100px',
  ].join(';');

  const caption = document.createElement('div');
  caption.style.cssText = [
    'position:absolute',
    'left:50%',
    'bottom:14px',
    'transform:translateX(-50%)',
    'max-width:80%',
    'padding:6px 12px',
    'border-radius:999px',
    'background:rgba(17,17,17,0.86)',
    'color:#fff',
    'font:500 13px/1.4 system-ui,sans-serif',
    'opacity:0',
    'transition:opacity 160ms ease',
    'white-space:nowrap',
    'overflow:hidden',
    'text-overflow:ellipsis',
  ].join(';');

  layer.appendChild(cursor);
  layer.appendChild(caption);
  document.documentElement.appendChild(layer);

  let captionTimer = null;

  window.__UI_PREVIEW__ = {
    moveTo(x, y) {
      cursor.style.left = x + 'px';
      cursor.style.top = y + 'px';
    },
    ring(x, y) {
      const ring = document.createElement('div');
      ring.style.cssText = [
        'position:absolute',
        'left:' + x + 'px',
        'top:' + y + 'px',
        'width:14px',
        'height:14px',
        'border-radius:50%',
        'border:2px solid rgba(37,99,235,0.9)',
        'transform:translate(-50%,-50%)',
        'animation:__ui_preview_ring 520ms ease-out forwards',
      ].join(';');
      layer.appendChild(ring);
      setTimeout(() => ring.remove(), 600);
    },
    caption(text) {
      if (!text) {
        return;
      }
      caption.textContent = text;
      caption.style.opacity = '1';
      clearTimeout(captionTimer);
      captionTimer = setTimeout(() => {
        caption.style.opacity = '0';
      }, 2200);
    },
    hide() {
      layer.style.display = 'none';
    },
    show() {
      layer.style.display = '';
    },
    errors() {
      return errors.slice(-20);
    },
  };

  const style = document.createElement('style');
  style.textContent =
    '@keyframes __ui_preview_ring{from{opacity:.9;transform:translate(-50%,-50%) scale(1)}to{opacity:0;transform:translate(-50%,-50%) scale(3.2)}}';
  document.documentElement.appendChild(style);
})();
`;

/**
 * Returns the center of an element in viewport coordinates, or null when the
 * element is gone. Used to place the overlay cursor before a real click.
 */
export const ELEMENT_CENTER_SCRIPT = String.raw`
const element = document.querySelector(arguments[0]);
if (!element) {
  return null;
}
const rect = element.getBoundingClientRect();
return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
`;
