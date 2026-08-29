import { useId, useRef, useState } from "react";

import { Alert } from "./alert";
import { Button } from "./button";
import { cn } from "./cn";
import { Input } from "./input";
import { Spinner } from "./spinner";

export interface ImageInputProps {
  label: string;
  hint?: string;
  value: string;
  onChange: (url: string) => void;
  /** Uploads the file and resolves to its public URL — the app supplies this (packages/ui makes no network calls itself). */
  onUploadFile: (file: File) => Promise<string>;
  uploadTabLabel: string;
  urlTabLabel: string;
  urlPlaceholder?: string;
  uploadButtonLabel: string;
  removeLabel: string;
  errorFallback: string;
  /** e.g. "PNG, JPEG or WEBP, up to 5MB" */
  constraintsHint?: string;
  className?: string;
}

const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp";

/**
 * Two ways to set an image: upload a file from the device, or paste a URL —
 * both land in the same `value`. Neither this component nor the rest of
 * packages/ui calls the network directly; `onUploadFile` is the app's own
 * upload function (it knows the API base URL and auth).
 */
export function ImageInput({
  label,
  hint,
  value,
  onChange,
  onUploadFile,
  uploadTabLabel,
  urlTabLabel,
  urlPlaceholder,
  uploadButtonLabel,
  removeLabel,
  errorFallback,
  constraintsHint,
  className,
}: ImageInputProps) {
  const [mode, setMode] = useState<"upload" | "url">("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const hintId = hint ? `${baseId}-hint` : undefined;

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const url = await onUploadFile(file);
      onChange(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : errorFallback);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <fieldset className={cn("space-y-2 border-0 p-0 m-0", className)}>
      <legend className="text-sm font-medium leading-none">{label}</legend>
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}

      <div className="flex gap-1 rounded-md border border-input bg-muted/40 p-1">
        {(
          [
            { key: "upload" as const, text: uploadTabLabel },
            { key: "url" as const, text: urlTabLabel },
          ]
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            aria-pressed={mode === tab.key}
            className={cn(
              "flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors",
              mode === tab.key ? "bg-card shadow-sm" : "text-muted-foreground",
            )}
            onClick={() => setMode(tab.key)}
          >
            {tab.text}
          </button>
        ))}
      </div>

      {error && <Alert variant="destructive">{error}</Alert>}

      {mode === "upload" ? (
        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_TYPES}
            className="sr-only"
            aria-describedby={hintId}
            aria-label={label}
            tabIndex={-1}
            id={`${baseId}-file`}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            {busy ? <Spinner className="border-primary" /> : uploadButtonLabel}
          </Button>
          {constraintsHint && <span className="text-xs text-muted-foreground">{constraintsHint}</span>}
        </div>
      ) : (
        <Input
          id={`${baseId}-url`}
          dir="ltr"
          type="url"
          placeholder={urlPlaceholder}
          aria-describedby={hintId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {value && (
        <div className="flex items-center gap-3 rounded-md border p-2">
          <img src={value} alt={label} className="h-12 w-12 rounded object-cover" />
          <span className="flex-1 truncate text-xs text-muted-foreground" dir="ltr">
            {value}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
            {removeLabel}
          </Button>
        </div>
      )}
    </fieldset>
  );
}
