import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Choosing a bundle, by drag-and-drop or by the file browser.
 *
 * Both routes reach the same handler. The file input stays in the DOM and
 * hidden rather than being created on demand — a keyboard user has to be able
 * to reach it, and a drop target alone is unusable without a pointer.
 */
export function Dropzone({
  onChoose,
  disabled,
  chosen,
}: {
  onChoose: (file: File) => void;
  disabled?: boolean;
  chosen?: File | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const take = (files: FileList | null) => {
    const file = files?.[0];
    if (file && !disabled) onChoose(file);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files);
      }}
      className={cn(
        "rounded-lg border-2 border-dashed p-8 text-center transition-colors",
        over ? "border-brand bg-brand/5" : "border-line",
        disabled && "opacity-60",
      )}
    >
      <p className="mb-1 text-ink">
        {chosen ? chosen.name : "Drop a bundle here"}
      </p>
      <p className="mb-4 text-sm text-muted">
        {chosen ? `${chosen.size.toLocaleString()} bytes` : "a .tar.gz built for this fleet"}
      </p>
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="text-sm underline disabled:no-underline"
      >
        or choose a file
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept=".gz,.tgz,application/gzip"
        onChange={(e) => take(e.target.files)}
      />
    </div>
  );
}
