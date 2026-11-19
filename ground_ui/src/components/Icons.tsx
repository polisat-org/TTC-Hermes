// Ícones de traço simples (24×24, currentColor), sem dependência externa.
type P = { size?: number };
const S = ({ size = 18, children }: P & { children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const IconBattery = (p: P) => (
  <S {...p}>
    <rect x="2" y="7" width="17" height="10" rx="2" />
    <path d="M22 11v2" />
    <path d="M6 10v4M10 10v4" />
  </S>
);
export const IconThermo = (p: P) => (
  <S {...p}>
    <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />
  </S>
);
export const IconSpin = (p: P) => (
  <S {...p}>
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 3v6h-6" />
  </S>
);
export const IconCompass = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z" />
  </S>
);
export const IconPlane = (p: P) => (
  <S {...p}>
    <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
  </S>
);
export const IconSignal = (p: P) => (
  <S {...p}>
    <path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 4v16" />
  </S>
);
export const IconAntenna = (p: P) => (
  <S {...p}>
    <path d="M12 12v10" />
    <path d="M8.5 8.5a5 5 0 0 1 7 0M5.6 5.6a9 9 0 0 1 12.8 0" />
    <circle cx="12" cy="12" r="1.5" />
  </S>
);
export const IconSend = (p: P) => (
  <S {...p}>
    <path d="m22 2-7 20-4-9-9-4z" />
    <path d="M22 2 11 13" />
  </S>
);
export const IconSat = (p: P) => (
  <S {...p}>
    <path d="m13 7 4-4 4 4-4 4" />
    <path d="m7 13-4 4 4 4 4-4" />
    <path d="m9 9 6 6" />
    <rect x="8" y="8" width="8" height="8" rx="1" transform="rotate(45 12 12)" />
  </S>
);
export const IconInfo = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </S>
);
export const IconTarget = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </S>
);
export const IconPower = (p: P) => (
  <S {...p}>
    <path d="M12 2v10" />
    <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
  </S>
);
