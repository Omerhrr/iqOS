'use client'

// IQAIR//OS - small reusable expand/collapse control used by panels that want
// an optional fullscreen view (Backtest Lab, Confluence Signal, Markov Chain).
// Pure UI: the parent owns the `active` boolean and toggles it - this just
// renders the icon + click target so all three panels stay visually
// consistent.
export function FullscreenButton({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={active ? 'Exit fullscreen' : 'Fullscreen'}
      aria-label={active ? 'Exit fullscreen' : 'Fullscreen'}
      className="rounded p-1 text-[#4b5a72] transition-colors hover:bg-[#141d2e] hover:text-cyan-300"
    >
      {active ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18-3v3a2 2 0 0 1-2 2h-3M18 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
        </svg>
      )}
    </button>
  )
}

/** Full-viewport backdrop shown behind a fullscreen'd panel - click it to close. */
export function FullscreenBackdrop({ onClose }: { onClose: () => void }) {
  return <div className="fixed inset-0 z-40 bg-black/70" onClick={onClose} />
}
