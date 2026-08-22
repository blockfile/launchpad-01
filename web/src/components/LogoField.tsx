import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

// Mirrors ponsfamily's own create form: the same accepted types, the same
// 5 MB ceiling and the same acknowledgement before the picker unlocks.
// Checked here too so an oversized or mistyped file fails instantly instead
// of after a round trip to the pin route.
const ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_BYTES = 5 * 1024 * 1024;

export interface LogoFieldProps {
  value: string;
  onChange: (uri: string) => void;
  /**
   * OPTIONAL. A caller with an arm switch (a launch form) uses this to hold
   * it closed while an upload is in flight; a caller with nothing to hold
   * simply omits it.
   */
  onUploading?: (uploading: boolean) => void;
}

interface PinResult {
  uri: string;
  gatewayUrl: string;
}

/**
 * Posts the file straight to this app's own `/api/pin` route — never to a
 * pinning provider directly, so no pinning credential is ever near browser
 * code (see `web/server/pin.ts`, the only place that credential is read).
 */
async function pinLogo(file: File): Promise<PinResult> {
  const res = await fetch("/api/pin", {
    method: "POST",
    headers: { "content-type": file.type },
    body: file,
  });
  const json = await res.json().catch(() => ({}) as Record<string, unknown>);
  if (!res.ok) {
    const message = typeof json.error === "string" ? json.error : "Upload failed.";
    throw new Error(message);
  }
  return json as PinResult;
}

export function LogoField({ value, onChange, onUploading }: LogoFieldProps) {
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const objectUrl = useRef("");

  // Object URLs leak until revoked, and this component outlives many picks.
  function showPreview(url: string) {
    if (objectUrl.current && objectUrl.current !== url) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = url.startsWith("blob:") ? url : "";
    setPreview(url);
  }
  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    []
  );

  function clear() {
    showPreview("");
    setFileName("");
    setError("");
    onChange("");
  }

  // A failed pick discards whatever logo was set: the value is already
  // cleared, so the thumbnail must go with it, or the field shows an image
  // that no longer backs the value a launch would use.
  function fail(message: string) {
    showPreview("");
    setFileName("");
    onChange("");
    setError(message);
  }

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!confirmed || busy) return;

    setError("");
    onChange("");
    if (!ACCEPT.includes(file.type)) return fail("Use a PNG, JPEG, WebP or GIF image.");
    if (!file.size) return fail("The image is empty.");
    if (file.size > MAX_BYTES) return fail("Images must be smaller than 5 MB.");

    showPreview(URL.createObjectURL(file));
    setFileName(file.name);
    setBusy(true);
    onUploading?.(true);
    try {
      const { uri, gatewayUrl } = await pinLogo(file);
      onChange(uri);
      showPreview(gatewayUrl);
    } catch (err) {
      fail(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
      onUploading?.(false);
    }
  }

  return (
    // A div, not a label: the confirm checkbox below gets its own label
    // instead, so clicking the caption/thumbnail/hint text can't toggle it.
    <div className="logo-field">
      <span className="logo-field-label">Logo</span>
      <label className="logo-confirm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I understand that selected artwork will be moderated and uploaded to public IPFS.
      </label>
      <input
        ref={input}
        type="file"
        aria-label="Logo image"
        accept={ACCEPT.join(",")}
        disabled={!confirmed || busy}
        onChange={pick}
        style={{ display: "none" }}
      />
      <span className="logo-box">
        {preview ? (
          <img className="logo-thumb" src={preview} alt="Selected logo preview" />
        ) : (
          <span className="logo-thumb logo-thumb-empty" />
        )}
        <span className="logo-meta">
          <button
            type="button"
            className="ghost"
            disabled={!confirmed || busy}
            onClick={() => input.current?.click()}
          >
            {busy ? "Uploading image…" : confirmed ? (value ? "Replace image" : "Choose image") : "Confirm public upload first"}
          </button>
          <span className="hint">
            {error ? (
              <span className="logo-error">{error}</span>
            ) : (
              value || `${fileName || "PNG, JPEG, WebP or GIF"} · 5 MB max`
            )}
          </span>
        </span>
        {value && !busy && (
          <button type="button" className="ghost" onClick={clear} aria-label="Remove logo">
            ✕
          </button>
        )}
      </span>
    </div>
  );
}
