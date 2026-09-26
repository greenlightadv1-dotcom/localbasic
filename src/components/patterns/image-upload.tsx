'use client';

import { useRef, useState } from 'react';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { uploadMedia, deleteMediaByUrl, type MediaPurpose } from '@/lib/storage/upload';

/**
 * A direct-file image field — logo, banner, category or product photo,
 * bundle image. Replaces a plain "paste a URL" text input everywhere in the
 * Site Engine and menu management: the file goes straight to Storage from
 * this component, and `onChange` only ever receives a real, already-hosted
 * URL.
 *
 * Uncontrolled toward the network, controlled toward the parent: the parent
 * owns `value` and gets a new URL through `onChange` once the upload has
 * actually finished — never a local blob: URL standing in for one, which
 * would work in this tab and be a dead reference the moment the row saves.
 */
export function ImageUpload({
  organizationId,
  purpose,
  value,
  onChange,
  label,
  aspectClassName = 'aspect-video',
}: {
  organizationId: string;
  purpose: MediaPurpose;
  value: string | null;
  onChange: (url: string | null) => void;
  label: string;
  /** Tailwind aspect-ratio class for the preview box — square for a logo, wide for a banner. */
  aspectClassName?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setError(null);
    setUploading(true);
    const previous = value;
    try {
      const { url } = await uploadMedia(organizationId, purpose, file);
      onChange(url);
      if (previous) void deleteMediaByUrl(previous);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر رفع الصورة');
    } finally {
      setUploading(false);
    }
  }

  function remove() {
    const previous = value;
    onChange(null);
    if (previous) void deleteMediaByUrl(previous);
  }

  return (
    <div>
      <span className="mb-1.5 block text-xs font-semibold text-fg">{label}</span>

      <div
        className={`relative w-full max-w-xs overflow-hidden rounded-lg border border-dashed border-line bg-surface ${aspectClassName}`}
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element -- a Storage
          // URL or an organization-supplied external one, not a build asset.
          <img src={value} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted">
            <ImagePlus className="h-6 w-6" aria-hidden="true" />
            <span className="text-xs">لا توجد صورة</span>
          </div>
        )}

        {isUploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-elevated/80">
            <Loader2 className="h-6 w-6 animate-spin text-muted" aria-hidden="true" />
          </div>
        )}

        {value && !isUploading && (
          <button
            type="button"
            onClick={remove}
            aria-label="إزالة الصورة"
            className="absolute end-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-danger text-white shadow"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
        className="sr-only"
        onChange={onPick}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        disabled={isUploading}
        onClick={() => inputRef.current?.click()}
      >
        {isUploading ? '…جارٍ الرفع' : value ? 'استبدال الصورة' : 'رفع صورة'}
      </Button>

      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
