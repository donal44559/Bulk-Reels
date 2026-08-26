import React from 'react';
import { createPortal } from 'react-dom';

// Modal — Escape closes, background click closes.
// Textareas and inputs inside NEVER lose their clicks: we do NOT stop
// propagation on the modal body, and we ONLY close on background click
// when both mousedown AND mouseup happened on the overlay itself.
//
// FIX (inputs/textarea unclickable & untypeable inside the modal):
// 1) The whole modal is rendered through a React PORTAL directly into
//    document.body. Any accidental ancestor stacking-context / transform /
//    filter / overflow quirk in a page can no longer cover the modal or
//    swallow its pointer events — the overlay now always lives at the very
//    top of the DOM, above everything the app renders.
// 2) The overlay no longer uses backdrop-filter (backdrop-blur). On some
//    Windows GPU/driver combinations Chromium mis-routes hit-testing for
//    backdrop-filter surfaces: the modal renders perfectly but receives NO
//    clicks/keystrokes at all. The dark overlay (bg-black/70) is unchanged —
//    only the cosmetic blur is gone, interaction is bulletproof.
// 3) pointer-events:'auto' is forced inline on the overlay AND the panel so
//    no inherited/parent pointer-events state can ever disable them.
export default function Modal({ title, children, onClose, wide, footer }) {
  const overlayRef = React.useRef(null);
  const mouseDownOnOverlay = React.useRef(false);

  // Close on ESC
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[9998] p-4"
      style={{ pointerEvents: 'auto', zIndex: 9998 }}
      onMouseDown={(e) => {
        // Only remember mousedown when it happened directly on the overlay.
        mouseDownOnOverlay.current = (e.target === overlayRef.current);
      }}
      onMouseUp={(e) => {
        // Only close if BOTH events happened on overlay itself — never on modal children.
        // This is a click-outside pattern that survives drag-selecting text inside a textarea.
        if (mouseDownOnOverlay.current && e.target === overlayRef.current) {
          onClose && onClose();
        }
        mouseDownOnOverlay.current = false;
      }}
    >
      <div
        className={`panel w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} max-h-[90vh] overflow-auto shadow-2xl`}
        style={{ pointerEvents: 'auto' }}
        // Do NOT stopPropagation here — we rely on target-equality above, and
        // stopPropagation caused intermittent textarea-click loss because the
        // overlay never learned mousedown happened elsewhere, leaving its ref stale.
      >
        <div className="px-5 py-4 border-b border-border flex items-center justify-between sticky top-0 bg-panel z-20">
          <h2 className="text-lg font-bold text-white">{title}</h2>
          <button className="text-slate-400 hover:text-white text-2xl leading-none" onClick={onClose}>×</button>
        </div>
        <div className="p-5">{children}</div>
        {footer && (
          <div className="px-5 py-4 border-t border-border flex justify-end gap-2 sticky bottom-0 bg-panel z-20">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
