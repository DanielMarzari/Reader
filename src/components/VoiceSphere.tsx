"use client";

/**
 * VoiceSphere — ElevenLabs-style animated planetary gradient sphere.
 *
 * Pure CSS. Props drive a deterministic color palette from `seed` so each
 * voice profile gets a consistent unique look. Rendered via CSS custom
 * properties --c1..c4 hooked into the .voice-sphere class in globals.css.
 *
 * IMPORTANT: This component is duplicated verbatim between the Reader repo
 * (DanielMarzari/Reader) and the Voice repo (DanielMarzari/Voice). When you
 * change it here, copy the file over to Voice's frontend/src/components/.
 * The CSS keyframes/classes live in each app's globals.css.
 */

import { useMemo } from "react";

type Props = {
  seed: string;
  size?: number;              // pixels
  animate?: boolean;
  withPlayIcon?: boolean;
  className?: string;
  onClick?: () => void;
  ariaLabel?: string;
};

const PALETTES: Array<[string, string, string, string]> = [
  ["#f6b4a6", "#d58cff", "#6190ff", "#9effd8"],
  ["#ffd0a6", "#ff6aa1", "#8f6bff", "#4ad5ff"],
  ["#ffe29d", "#ff9478", "#c563ff", "#6f93ff"],
  ["#e0d7ff", "#9486ff", "#ff7ac7", "#ffc27a"],
  ["#b5ffd4", "#5dd6a9", "#4a8ef0", "#b980ff"],
  ["#ffb3d1", "#ff5c8a", "#9c5bff", "#37a0ff"],
  ["#fff1a9", "#ffa65c", "#ff6666", "#c05cff"],
  ["#c2e8ff", "#4d9cff", "#8b3fff", "#ff6e9a"],
  ["#d7c4ff", "#b780ff", "#6e5cff", "#4ecbff"],
  ["#ffd6e0", "#ff8fa6", "#ffb36e", "#ffe29d"],
];

function pickPalette(seed: string): [string, string, string, string] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = Math.abs(h) % PALETTES.length;
  return PALETTES[idx];
}

export function VoiceSphere({
  seed,
  size = 160,
  animate = true,
  withPlayIcon = false,
  className = "",
  onClick,
  ariaLabel,
}: Props) {
  const [c1, c2, c3, c4] = useMemo(() => pickPalette(seed), [seed]);

  const style: React.CSSProperties & Record<string, string> = {
    width: `${size}px`,
    height: `${size}px`,
    "--c1": c1,
    "--c2": c2,
    "--c3": c3,
    "--c4": c4,
  };

  const cls = [
    "voice-sphere",
    animate ? "" : "voice-sphere-static",
    onClick ? "cursor-pointer" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={cls}
      style={style}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={ariaLabel}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {withPlayIcon && (
        <div className="voice-sphere-play" aria-hidden>
          <svg
            width="38%"
            height="38%"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      )}
    </div>
  );
}
