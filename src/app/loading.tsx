export default function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center" role="status" aria-label="جارٍ التحميل">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-primary" />
    </div>
  );
}
