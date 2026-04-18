"use client";

type Theme = "system" | "light" | "dark";

export type ReaderSettings = {
  theme: Theme;
  highlightSentence: boolean;
  clickToListen: boolean;
};

export const defaultSettings: ReaderSettings = {
  theme: "system",
  highlightSentence: true,
  clickToListen: false,
};

/** Apply theme to document root. */
export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

/** Read settings from localStorage (lazy). Always returns a valid object. */
export function loadSettings(): ReaderSettings {
  if (typeof window === "undefined") return defaultSettings;
  try {
    const raw = window.localStorage.getItem("reader-settings");
    if (!raw) return defaultSettings;
    const parsed = JSON.parse(raw);
    return { ...defaultSettings, ...parsed };
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(s: ReaderSettings) {
  try {
    window.localStorage.setItem("reader-settings", JSON.stringify(s));
  } catch {
    // quota / private mode — ignore
  }
}

export function SettingsDrawer({
  open,
  onClose,
  settings,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  settings: ReaderSettings;
  onChange: (next: ReaderSettings) => void;
}) {
  if (!open) return null;

  function update(patch: Partial<ReaderSettings>) {
    const next = { ...settings, ...patch };
    onChange(next);
    saveSettings(next);
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Settings">
        <div className="flex items-center justify-between h-[53px] px-4 border-b border-[color:var(--border)] shrink-0">
          <h2 className="text-base font-semibold">Settings</h2>
          <button className="btn-ghost" onClick={onClose} aria-label="Close settings">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6 L18 18 M18 6 L6 18" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-6 overflow-y-auto">
          <section>
            <div className="flex items-center justify-between mb-2">
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
            </div>
          </section>

          <section className="flex items-center justify-between gap-4">
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

          <section className="flex items-center justify-between gap-4">
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
        </div>
      </aside>
    </>
  );
}
