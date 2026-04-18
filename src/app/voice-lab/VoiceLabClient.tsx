"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { VoiceSphere } from "@/components/VoiceSphere";

type VoiceProfile = {
  id: string;
  name: string;
  kind: "cloned" | "designed" | "uploaded";
  engine: string;
  createdAt: string;
  design: Record<string, unknown> & { colors?: string[] | null };
  hasSample: boolean;
  coverUrl: string | null;
};

export function VoiceLabClient() {
  const [voices, setVoices] = useState<VoiceProfile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [tokenPanelOpen, setTokenPanelOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/voices", { cache: "no-store" });
      const j = (await r.json()) as { voices: VoiceProfile[] };
      setVoices(j.voices ?? []);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm("Delete this voice? This removes it from Reader but not from the Voice Studio app on your Mac.")) return;
      const r = await fetch(`/api/voices/${id}`, { method: "DELETE" });
      if (r.ok) load();
      else alert("Delete failed: " + (await r.text()));
    },
    [load]
  );

  return (
    <div className="min-h-screen" style={{ background: "var(--background)" }}>
      <header className="sticky top-0 z-30 bg-[color:var(--background)]/90 backdrop-blur border-b border-[color:var(--border)]">
        <div className="flex items-center justify-between gap-3 px-5 py-3 max-w-[1400px] mx-auto">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="text-sm text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
              aria-label="Back to library"
            >
              ←
            </Link>
            <div className="flex items-center gap-2">
              <VoiceSphere seed="voice-lab-logo" size={32} />
              <h1 className="text-lg font-bold">Voice Lab</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn" onClick={() => setUploadOpen(true)}>
              + Upload Voice
            </button>
            <button
              className="btn"
              onClick={() => setTokenPanelOpen((x) => !x)}
            >
              {tokenPanelOpen ? "Hide" : "Connect Voice Studio"}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-5 py-8">
        <div className="max-w-2xl mb-10">
          <h2 className="text-2xl font-semibold tracking-tight mb-2">Your voices</h2>
          <p className="text-sm text-[color:var(--muted)]">
            Clone a voice from an audio sample, or design one from scratch, using
            the <strong>Voice Studio</strong> app on your Mac. The results show up
            here — click a sphere to hear a preview.
          </p>
        </div>

        {tokenPanelOpen && <TokenPanel />}

        {loadError && (
          <div className="text-sm text-red-500 mb-6">
            Couldn&apos;t load voices: {loadError}
          </div>
        )}

        {voices === null ? (
          <div className="text-sm text-[color:var(--muted)]">Loading…</div>
        ) : voices.length === 0 ? (
          <EmptyState />
        ) : (
          <VoiceGallery
            voices={voices}
            playingId={playingId}
            setPlayingId={setPlayingId}
            onDelete={handleDelete}
          />
        )}
      </main>

      <UploadVoiceModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => {
          setUploadOpen(false);
          load();
        }}
      />
    </div>
  );
}

function VoiceGallery({
  voices,
  playingId,
  setPlayingId,
  onDelete,
}: {
  voices: VoiceProfile[];
  playingId: string | null;
  setPlayingId: (id: string | null) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-8">
      {voices.map((v) => (
        <VoiceCard
          key={v.id}
          voice={v}
          playing={playingId === v.id}
          onPlay={() => setPlayingId(playingId === v.id ? null : v.id)}
          onDelete={() => onDelete(v.id)}
        />
      ))}
    </div>
  );
}

function VoiceCard({
  voice,
  playing,
  onPlay,
  onDelete,
}: {
  voice: VoiceProfile;
  playing: boolean;
  onPlay: () => void;
  onDelete: () => void;
}) {
  const subtitle = useMemo(() => {
    if (voice.kind === "cloned") return "Cloned voice";
    if (voice.kind === "uploaded") return "Uploaded";
    const d = voice.design as { base_voice?: string };
    return d.base_voice ? `Designed · ${d.base_voice}` : "Designed voice";
  }, [voice]);

  // If the voice has a user-provided cover image, show THAT instead of the
  // dynamic sphere. Otherwise render the sphere, using the exact palette
  // saved from Voice Studio when available (falls back to seed-derived).
  const sphereColors = Array.isArray(voice.design.colors) && voice.design.colors.length === 4
    ? (voice.design.colors as [string, string, string, string])
    : undefined;

  return (
    <div className="group flex flex-col items-center text-center">
      <div className="relative">
        {voice.coverUrl ? (
          <CoverImage
            url={voice.coverUrl}
            alt={voice.name}
            size={160}
            playing={playing}
            hasSample={voice.hasSample}
            onClick={voice.hasSample ? onPlay : undefined}
          />
        ) : (
          <VoiceSphere
            seed={voice.id}
            size={160}
            speaking={playing}
            withPlayIcon={!playing}
            colors={sphereColors}
            onClick={voice.hasSample ? onPlay : undefined}
            ariaLabel={`Play ${voice.name}`}
          />
        )}
      </div>
      <div className="mt-4">
        <div className="font-medium">{voice.name}</div>
        <div className="text-xs text-[color:var(--muted)] mt-0.5">{subtitle}</div>
      </div>
      {playing && voice.hasSample && (
        <audio
          autoPlay
          controls
          className="w-full mt-3"
          src={`/api/voices/${voice.id}/sample`}
          onEnded={() => onPlay()}
        />
      )}
      <button
        className="text-xs text-[color:var(--muted)] hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity mt-2"
        onClick={onDelete}
      >
        Delete
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="card max-w-xl mx-auto text-center py-12">
      <div className="flex justify-center mb-4">
        <VoiceSphere seed="empty" size={140} />
      </div>
      <div className="text-lg font-medium mb-2">No voices yet</div>
      <div className="text-sm text-[color:var(--muted)] mb-6">
        Open the Voice Studio app on your Mac, clone or design a voice, and it
        will appear here automatically.
      </div>
      <div className="text-xs text-[color:var(--muted)]">
        Don&apos;t have Voice Studio?{" "}
        <a
          href="https://github.com/DanielMarzari/Voice"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-[color:var(--foreground)]"
        >
          Get it here →
        </a>
      </div>
    </div>
  );
}

// ---- Token panel ----

type MintedToken = {
  token: string;
  record: { label: string | null; createdAt: string; lastUsedAt: string | null };
  warning: string;
};

type TokenInfo = { label: string | null; createdAt: string; lastUsedAt: string | null };

function TokenPanel() {
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [label, setLabel] = useState("Voice Studio on my Mac");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/voice-lab/token", { cache: "no-store" });
      const j = (await r.json()) as { tokens: TokenInfo[] };
      setTokens(j.tokens ?? []);
    } catch {
      setTokens([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function mint() {
    setBusy(true);
    try {
      const r = await fetch("/api/voice-lab/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!r.ok) throw new Error(await r.text());
      setMinted((await r.json()) as MintedToken);
      load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeAll() {
    if (!confirm("Revoke ALL tokens? Voice Studio will stop being able to upload until you mint a new one.")) return;
    setBusy(true);
    try {
      await fetch("/api/voice-lab/token", { method: "DELETE" });
      setMinted(null);
      load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mb-10 max-w-3xl">
      <div className="font-medium mb-2">Connect Voice Studio</div>
      <p className="text-sm text-[color:var(--muted)] mb-4">
        Voice Studio uploads cloned/designed voices to this server. Mint a bearer
        token here and paste it into Voice Studio&apos;s{" "}
        <code className="text-xs bg-[color:var(--surface-2)] px-1.5 py-0.5 rounded">
          .env.local
        </code>{" "}
        as{" "}
        <code className="text-xs bg-[color:var(--surface-2)] px-1.5 py-0.5 rounded">
          READER_AUTH_TOKEN
        </code>
        .
      </p>

      <div className="flex gap-2 items-center">
        <input
          className="input flex-1"
          placeholder="Label (e.g. 'Voice Studio on my Mac')"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={60}
        />
        <button className="btn btn-primary" onClick={mint} disabled={busy}>
          Mint token
        </button>
      </div>

      {minted && (
        <div className="mt-4 p-3 rounded-lg bg-[color:var(--surface-2)] border border-[color:var(--border)]">
          <div className="text-xs text-[color:var(--muted)] mb-1.5">
            ⚠ Copy this now — it won&apos;t be shown again.
          </div>
          <div className="flex items-center gap-2">
            <code className="text-xs flex-1 break-all bg-[color:var(--background)] px-2 py-1.5 rounded border border-[color:var(--border)]">
              {minted.token}
            </code>
            <button
              className="btn text-xs"
              onClick={() => {
                navigator.clipboard?.writeText(minted.token);
              }}
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {tokens && tokens.length > 0 && (
        <div className="mt-4">
          <div className="text-xs uppercase tracking-wider text-[color:var(--muted)] mb-2">
            Active tokens ({tokens.length})
          </div>
          <ul className="text-sm space-y-1">
            {tokens.map((t, i) => (
              <li key={i} className="flex items-center justify-between">
                <span>
                  {t.label ?? <em className="text-[color:var(--muted)]">no label</em>}
                </span>
                <span className="text-xs text-[color:var(--muted)]">
                  created {new Date(t.createdAt).toLocaleDateString()}
                  {t.lastUsedAt && ` · last used ${new Date(t.lastUsedAt).toLocaleDateString()}`}
                </span>
              </li>
            ))}
          </ul>
          <button
            className="text-xs text-red-500 hover:underline mt-3"
            onClick={revokeAll}
            disabled={busy}
          >
            Revoke all tokens
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Cover image (replaces the sphere when the voice has one) ----

function CoverImage({
  url,
  alt,
  size,
  playing,
  hasSample,
  onClick,
}: {
  url: string;
  alt: string;
  size: number;
  playing: boolean;
  hasSample: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      className={`voice-cover ${playing ? "voice-cover--playing" : ""} ${
        hasSample ? "voice-cover--clickable" : ""
      }`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
      style={{ width: size, height: size }}
      aria-label={`Play ${alt}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} draggable={false} />
      {!playing && hasSample && (
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

// ---- Upload voice modal ----

type UploadProps = {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
};

function UploadVoiceModal({ open, onClose, onUploaded }: UploadProps) {
  const [name, setName] = useState("");
  const [audio, setAudio] = useState<File | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName("");
      setAudio(null);
      setCover(null);
      if (coverPreview) URL.revokeObjectURL(coverPreview);
      setCoverPreview(null);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!cover) {
      if (coverPreview) URL.revokeObjectURL(coverPreview);
      setCoverPreview(null);
      return;
    }
    const url = URL.createObjectURL(cover);
    setCoverPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [cover]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  async function submit() {
    if (!name.trim() || !audio || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("name", name.trim());
      fd.append("audio", audio);
      if (cover) fd.append("cover", cover);
      const r = await fetch("/api/voices", { method: "POST", body: fd });
      if (!r.ok) {
        throw new Error(`${r.status}: ${await r.text()}`);
      }
      onUploaded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="card w-full max-w-md m-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Upload a voice</h2>
          <button
            onClick={onClose}
            className="text-[color:var(--muted)] hover:text-[color:var(--foreground)] text-lg"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1">Name</label>
            <input
              className="input w-full"
              placeholder="e.g. Dad, Morgan Freeman, Narrator"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Audio file</label>
            <input
              type="file"
              accept="audio/*,.mp3,.wav,.ogg,.m4a"
              onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
            />
            {audio && (
              <div className="text-xs text-[color:var(--muted)] mt-1">
                {audio.name} · {(audio.size / 1024).toFixed(0)} KB
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">
              Cover image
              <span className="ml-2 text-[color:var(--muted)] font-normal">
                optional · replaces the animated sphere
              </span>
            </label>
            <div className="flex items-center gap-3">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(e) => setCover(e.target.files?.[0] ?? null)}
              />
              {coverPreview && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={coverPreview}
                  alt="cover preview"
                  className="w-12 h-12 rounded-full object-cover border border-[color:var(--border)]"
                />
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 mt-6">
          {error && (
            <span className="text-xs text-red-500 flex-1 break-all">{error}</span>
          )}
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || !name.trim() || !audio}
          >
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}
