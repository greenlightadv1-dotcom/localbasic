'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LazyMotion, domAnimation, m, useReducedMotion } from 'framer-motion';

/**
 * Liquid page transitions and the store splash.
 *
 * Both are one primitive: a tall sheet of the store's brand colour with a wavy
 * top and bottom edge whose curves keep morphing. It rises over the screen to
 * cover a page, and leaves upward to reveal the next one — like a wave
 * washing across the phone. It is sized so that, at rest, both wavy edges are
 * off-screen and only solid colour shows.
 */
const WAVE_H = 96;
const WAVE_A = 'M0,64 C240,0 480,128 720,64 C960,0 1200,128 1440,64 L1440,160 L0,160 Z';
const WAVE_B = 'M0,64 C240,128 480,0 720,64 C960,128 1200,0 1440,64 L1440,160 L0,160 Z';

function Edge({ flip, reduce }: { flip?: boolean; reduce: boolean | null }) {
  return (
    <svg
      viewBox="0 0 1440 160" preserveAspectRatio="none" aria-hidden="true"
      className={`block w-full text-primary ${flip ? '-scale-y-100' : ''}`}
      style={{ height: WAVE_H, marginBottom: flip ? 0 : -1, marginTop: flip ? -1 : 0 }}
    >
      <m.path
        fill="currentColor"
        initial={{ d: WAVE_A }}
        animate={reduce ? { d: WAVE_A } : { d: [WAVE_A, WAVE_B, WAVE_A] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
      />
    </svg>
  );
}

/** The full-screen sheet. `y` moves it; children sit on the solid part. */
function Sheet({
  y, initialY, duration, onDone, children, reduce,
}: {
  y: string;
  initialY: string;
  duration: number;
  onDone?: () => void;
  children?: React.ReactNode;
  reduce: boolean | null;
}) {
  return (
    <m.div
      initial={{ y: initialY }}
      animate={{ y }}
      transition={{ duration: reduce ? 0.01 : duration, ease: [0.76, 0, 0.24, 1] }}
      onAnimationComplete={onDone}
      className="fixed inset-x-0 z-[90] flex flex-col"
      style={{ top: -WAVE_H, height: `calc(100dvh + ${WAVE_H * 2}px)` }}
    >
      <Edge reduce={reduce} />
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center bg-primary text-primary-fg">
        {children}
      </div>
      <Edge flip reduce={reduce} />
    </m.div>
  );
}

// ---------------------------------------------------------------------------
// Splash
// ---------------------------------------------------------------------------
const AUTO_MS = 2800;

export function StoreSplash({
  scopeKey, name, logoUrl, tagline,
}: {
  /** One splash per store per browser tab session. */
  scopeKey: string;
  name: string;
  logoUrl: string | null;
  tagline?: string | null;
}) {
  const key = `lb-splash:${scopeKey}`;
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<'show' | 'leave' | 'gone'>('show');
  const started = useRef(false);

  // Already seen this session (e.g. back from the tracking page): never show.
  useEffect(() => {
    let seen = false;
    try { seen = sessionStorage.getItem(key) === '1'; } catch { /* blocked storage: show it once per page load */ }
    if (seen) setPhase('gone');
  }, [key]);

  // Remembered once the guest is past it, so a reload mid-splash shows it again.
  useEffect(() => {
    if (phase !== 'leave') return;
    try { sessionStorage.setItem(key, '1'); } catch { /* ignore */ }
  }, [phase, key]);

  // Hold the page still behind it, and go on our own after a moment.
  useEffect(() => {
    if (phase !== 'show') return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => setPhase('leave'), reduce ? 700 : AUTO_MS);
    return () => {
      document.body.style.overflow = prev;
      clearTimeout(timer);
    };
  }, [phase, reduce]);

  if (phase === 'gone') return null;
  const initial = (name.trim().slice(0, 2) || '·');

  return (
    <>
      <div
        id="lb-splash" role="dialog" aria-label={`مرحبًا بك في ${name}`} data-testid="store-splash"
        className="contents"
      >
        <LazyMotion features={domAnimation} strict>
          <Sheet
            y={phase === 'leave' ? '-100%' : '0%'} initialY="0%"
            duration={1.05} reduce={reduce}
            onDone={() => { if (phase === 'leave' && !started.current) { started.current = true; setPhase('gone'); } }}
          >
            <div className="flex flex-col items-center px-8 text-center">
              <div className="relative flex h-40 w-40 items-center justify-center">
                <span className="absolute inset-0 animate-ping rounded-full bg-white/15" aria-hidden="true" />
                <span className="absolute inset-4 animate-ping rounded-full bg-white/15 [animation-delay:400ms]" aria-hidden="true" />
                <span className="relative flex h-28 w-28 animate-bounce-soft items-center justify-center overflow-hidden rounded-full bg-white text-4xl font-extrabold text-primary shadow-[0_18px_40px_rgba(0,0,0,.25)]">
                  {logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- an organization-supplied URL.
                    <img src={logoUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    initial
                  )}
                </span>
              </div>
              <span className="-mt-3 h-3 w-20 animate-shadow-squash rounded-[50%] bg-black" aria-hidden="true" />

              <h1 className="mt-6 animate-fade-up text-3xl font-extrabold tracking-wide [animation-delay:250ms]">{name}</h1>
              {tagline ? (
                <p className="mt-2 max-w-xs animate-fade-up text-sm opacity-90 [animation-delay:450ms]">{tagline}</p>
              ) : null}

              <button
                type="button" onClick={() => setPhase('leave')} autoFocus
                className="mt-8 animate-fade-up rounded-full bg-white px-8 py-3 text-base font-extrabold text-primary shadow-[0_10px_24px_rgba(0,0,0,.2)] transition-transform [animation-delay:750ms] active:scale-95"
              >
                ابدأ الطلب 🍽️
              </button>
              <span className="mt-6 flex gap-1.5" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/70" style={{ animationDelay: `${i * 180}ms` }} />
                ))}
              </span>
            </div>
          </Sheet>
        </LazyMotion>
      </div>
      {/* Before React wakes up: a visit already seen this session never flashes the splash. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `try{if(sessionStorage.getItem(${JSON.stringify(key)})==='1'){var s=document.getElementById('lb-splash');if(s)s.style.display='none';}}catch(e){}`,
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Page-to-page transitions
// ---------------------------------------------------------------------------
const GO_EVENT = 'lb-liquid-go';
const ARRIVE_FLAG = 'lb-liquid-arrive';
const ARRIVE_TTL_MS = 6000;

/**
 * Lives on every page a LiquidLink can start from or arrive at. On a link it
 * floods the screen, then navigates; on arrival it drains away to show the new
 * page. Without it a LiquidLink is just an ordinary link.
 */
export function LiquidTransitions() {
  const router = useRouter();
  const reduce = useReducedMotion();
  const target = useRef<string | null>(null);
  // Read on the first client render, so an arriving page is covered from the
  // very first paint instead of flashing its content.
  const [phase, setPhase] = useState<'idle' | 'cover' | 'reveal'>(() => {
    if (typeof window === 'undefined') return 'idle';
    try {
      const at = Number(sessionStorage.getItem(ARRIVE_FLAG) ?? 0);
      return at > 0 && Date.now() - at < ARRIVE_TTL_MS ? 'reveal' : 'idle';
    } catch {
      return 'idle';
    }
  });

  useEffect(() => {
    try { sessionStorage.removeItem(ARRIVE_FLAG); } catch { /* ignore */ }
    const on = (e: Event) => {
      const detail = (e as CustomEvent<{ href: string; handled: boolean }>).detail;
      detail.handled = true;
      target.current = detail.href;
      setPhase('cover');
    };
    window.addEventListener(GO_EVENT, on);
    return () => window.removeEventListener(GO_EVENT, on);
  }, []);

  if (phase === 'idle') return null;
  return (
    <LazyMotion features={domAnimation} strict>
      <Sheet
        key={phase}
        reduce={reduce}
        initialY={phase === 'cover' ? '100%' : '0%'}
        y={phase === 'cover' ? '0%' : '-100%'}
        duration={phase === 'cover' ? 0.55 : 0.8}
        onDone={() => {
          if (phase === 'cover' && target.current) {
            try { sessionStorage.setItem(ARRIVE_FLAG, String(Date.now())); } catch { /* ignore */ }
            router.push(target.current);
          } else if (phase === 'reveal') {
            setPhase('idle');
          }
        }}
      />
    </LazyMotion>
  );
}

/** An ordinary link that washes the page away before navigating. */
export function LiquidLink({
  href, children, onClick, ...rest
}: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string }) {
  const router = useRouter();
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        const detail = { href, handled: false };
        window.dispatchEvent(new CustomEvent(GO_EVENT, { detail }));
        if (!detail.handled) router.push(href);
      }}
    >
      {children}
    </a>
  );
}
