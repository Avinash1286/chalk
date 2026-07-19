import { cn } from "@/lib/utils";

// Aperture / iris mark echoing the reference product's "eye". Pure SVG so it
// stays crisp at any size and needs no assets.
export function BrandMark({ className, size = 28 }: { className?: string; size?: number }) {
  const blades = Array.from({ length: 8 }, (_, i) => i);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <defs>
        <radialGradient id="apertureBg" cx="38%" cy="34%" r="72%">
          <stop offset="0%" stopColor="#f3f4f6" />
          <stop offset="55%" stopColor="#cfd3da" />
          <stop offset="100%" stopColor="#9aa1ad" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="48" fill="url(#apertureBg)" stroke="#8a909b" strokeWidth="1.5" />
      <g transform="translate(50 50)">
        {blades.map((i) => (
          <path
            key={i}
            d="M0,-36 A36,36 0 0,1 25.5,-25.5 L6,-6 A9,9 0 0,0 0,-9 Z"
            fill="#e7e9ee"
            stroke="#aab0ba"
            strokeWidth="0.8"
            transform={`rotate(${i * 45})`}
            opacity={0.92}
          />
        ))}
        <circle r="16" fill="#1f2430" />
        <circle cx="6" cy="-5" r="4.5" fill="#f6f7f9" opacity="0.9" />
      </g>
    </svg>
  );
}
