"use client";

import { useState } from "react";
import {
  AUTOSKIP_ACTIVE,
  defaultAutoSkip,
  type AutoSkipSettings,
} from "@/lib/autoskip";

type Theme = "system" | "light" | "dark";
export type View = "text" | "pages";

export type ReaderSettings = {
  theme: Theme;
  view: View;
  highlightSentence: boolean;
  clickToListen: boolean;
  autoSkip: AutoSkipSettings;
};

export const defaultSettings: ReaderSettings = {
  theme: "system",
  view: "text",
  highlightSentence: true,
  clickToListen: false,
  autoSkip: defaultAutoSkip,
};

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

export function loadSettings(): ReaderSettings {
  if (typeof window === "undefined") return defaultSettings;
  try {
    const raw = window.localStorage.getItem("reader-settings");
    if (!raw) return defaultSettings;
    const parsed = JSON.parse(raw);
    // Merge nested autoSkip to pick up new keys added in later versions.
    return {
      ...defaultSettings,
      ...parsed,
      autoSkip: { ...defaultSettings.autoSkip, ...(parsed?.autoSkip ?? {}) },
    };
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(s: ReaderSettings) {
  try {
    window.localStorage.setItem("reader-settings", JSON.stringify(s));
  } catch {}
}

type AutoSkipKey = Exclude<keyof AutoSkipSettings, "enabled">;

const AUTOSKIP_ROWS: Array<{ key: AutoSkipKey; label: string; description: string; icon: string }> = [
  { key: "headers", label: "Headers", description: "Repeated page headers at the top of each page.", icon: "↥" },
  { key: "footers", label: "Footers", description: "Repeated page footers and page numbers.", icon: "↧" },
  { key: "footnotes", label: "Footnotes", description: "Numbered footnote blocks at the bottom of pages.", icon: "ⁿ" },
  { key: "tables", label: "Tables", description: "Tabular data grids.", icon: "▦" },
  { key: "formulas", label: "Formulas", description: "Math and chemistry formulas.", icon: "∑" },
  { key: "citations", label: "Citations", description: "(Author, 2024) and [12] style references.", icon: "§" },
  { key: "urls", label: "URLs", description: "Links like https://example.com.", icon: "🔗" },
  { key: "parentheses", label: "Parentheses", description: "Skip anything inside ( ).", icon: "( )" },
  { key: "brackets", label: "Brackets", description: "Skip anything inside [ ].", icon: "[ ]" },
  { key: "braces", label: "Braces", description: "Skip anything inside { }.", icon: "{ }" },
];

export function SettingsDrawer({
  open,
  onClose,
  settings,
  onChange,
  pagesAvailable,
}: {
  open: boolean;
  onClose: () => void;
  settings: ReaderSettings;
  onChange: (next: ReaderSettings) => void;
  pagesAvailable: boolean;
}) {
  const [panel, setPanel] = useState<"main" | "autoskip">("main");
  // Nothing from the TTS context is needed in Settings anymore — the
  // engine toggle is gone (see the plan file). Kept useTTS import out.

  if (!open) return null;

  function update(patch: Partial<ReaderSettings>) {
    const next = { ...settings, ...patch };
    onChange(next);
    saveSettings(next);
  }
  function updateAutoSkip(patch: Partial<AutoSkipSettings>) {
    update({ autoSkip: { ...settings.autoSkip, ...patch } });
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Settings">
        <div className="flex items-center justify-between h-[53px] px-4 border-b border-[color:var(--border)] shrink-0">
          {panel === "autoskip" ? (
            <button className="btn-ghost" onClick={() => setPanel("main")} aria-label="Back">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 6 L9 12 L15 18" />
              </svg>
            </button>
          ) : (
            <div className="w-9" />
          )}
          <h2 className="text-base font-semibold">
            {panel === "autoskip" ? "Auto-Skip Content" : "Settings"}
          </h2>
          <button className="btn-ghost" onClick={onClose} aria-label="Close settings">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6 L18 18 M18 6 L6 18" />
            </svg>
          </button>
        </div>

        {panel === "main" ? (
          <div className="p-5 space-y-6 overflow-y-auto">
            <section className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-medium">View</div>
                <div className="text-xs text-[color:var(--muted)]">
                  Switch between extracted text and original PDF pages.
                </div>
              </div>
              <div className="seg">
                {(["text", "pages"] as View[]).map((v) => {
                  const disabled = v === "pages" && !pagesAvailable;
                  return (
                    <button
                      key={v}
                      className={settings.view === v ? "active" : ""}
                      onClick={() => !disabled && update({ view: v })}
                      disabled={disabled}
                      title={disabled ? "Pages view is only available for PDFs" : ""}
                      style={disabled ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
                    >
                      {v === "text" ? "Text" : "Pages"}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-medium">App Theme</div>
                <div className="text-xs text-[color:var(--muted)]">
                  Match system, or force light/dark.
                </div>
              </div>
              <div className="seg">
                {(["system", "light", "dark"] as Theme[]).map((t) => (
                  <button
                    key={t}
                    className={settings.theme === t ? "active" : ""}
                    onClick={() => {
                      update({ theme: t });
                      applyTheme(t);
                    }}
                  >
                    {t === "system" ? "Auto" : t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </section>

            <section className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-medium">Highlight Sentence</div>
                <div className="text-xs text-[color:var(--muted)]">
                  Soft background on the current sentence as it reads.
                </div>
              </div>
              <button
                className={`toggle ${settings.highlightSentence ? "on" : ""}`}
                onClick={() => update({ highlightSentence: !settings.highlightSentence })}
                aria-pressed={settings.highlightSentence}
                aria-label="Toggle sentence highlight"
              />
            </section>

            <section className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-medium">Click to Listen</div>
                <div className="text-xs text-[color:var(--muted)]">
                  Click any word to start playback from there.
                </div>
              </div>
              <button
                className={`toggle ${settings.clickToListen ? "on" : ""}`}
                onClick={() => update({ clickToListen: !settings.clickToListen })}
                aria-pressed={settings.clickToListen}
                aria-label="Toggle click-to-listen"
              />
            </section>

            <button
              className="w-full flex items-center justify-between py-3 border-t border-[color:var(--border)] pt-4 text-left"
              onClick={() => setPanel("autoskip")}
            >
              <div>
                <div className="text-sm font-medium">Auto-Skip Content</div>
                <div className="text-xs text-[color:var(--muted)]">
                  {settings.autoSkip.enabled
                    ? Object.entries(settings.autoSkip)
                        .filter(([k, v]) => k !== "enabled" && v)
                        .map(([k]) => k)
                        .slice(0, 3)
                        .join(", ") || "Enabled"
                    : "Off"}
                </div>
              </div>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M9 6 L15 12 L9 18" />
              </svg>
            </button>
          </div>
        ) : (
          <div className="p-5 space-y-4 overflow-y-auto">
            <section className="flex items-start justify-between gap-4 pb-4 border-b border-[color:var(--border)]">
              <div>
                <div className="text-sm font-medium">Skip All</div>
                <div className="text-xs text-[color:var(--muted)]">
                  Master switch for all auto-skip behavior.
                </div>
              </div>
              <button
                className={`toggle ${settings.autoSkip.enabled ? "on" : ""}`}
                onClick={() => updateAutoSkip({ enabled: !settings.autoSkip.enabled })}
                aria-pressed={settings.autoSkip.enabled}
                aria-label="Toggle auto-skip master"
              />
            </section>

            <div className="space-y-3">
              {AUTOSKIP_ROWS.map((row) => {
                const active = AUTOSKIP_ACTIVE[row.key];
                const value = settings.autoSkip[row.key];
                return (
                  <div
                    key={row.key}
                    className="flex items-start justify-between gap-3"
                    style={{ opacity: settings.autoSkip.enabled ? 1 : 0.55 }}
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-[color:var(--surface-2)] border border-[color:var(--border)] flex items-center justify-center text-sm text-[color:var(--muted)] shrink-0">
                        {row.icon}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium flex items-center gap-2">
                          {row.label}
                          {!active && (
                            <span className="text-[10px] text-[color:var(--muted)] bg-[color:var(--surface-2)] px-1.5 py-0.5 rounded">
                              coming soon
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-[color:var(--muted)]">
                          {row.description}
                        </div>
                      </div>
                    </div>
                    <button
                      className={`toggle ${value ? "on" : ""}`}
                      onClick={() => updateAutoSkip({ [row.key]: !value } as Partial<AutoSkipSettings>)}
                      aria-pressed={value}
                      aria-label={`Toggle ${row.label}`}
                      disabled={!settings.autoSkip.enabled}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
