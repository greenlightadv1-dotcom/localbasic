import { z } from 'zod';

export const STATION_KINDS = ['kitchen', 'bar'] as const;
export type StationKind = (typeof STATION_KINDS)[number];

export const stationSchema = z.object({
  name: z.string().trim().min(1, 'اسم المحطة مطلوب').max(80),
  kind: z.enum(STATION_KINDS),
  printerIp: z
    .string()
    .trim()
    .regex(
      /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[a-zA-Z0-9.-]+)$/,
      'عنوان IP أو اسم جهاز غير صالح',
    )
    .max(255)
    .optional()
    .or(z.literal('')),
  printerPort: z.coerce.number().int().min(1).max(65535).default(9100),
  sortOrder: z.coerce.number().int().min(0).default(0),
});

export const stationIdSchema = z.object({ stationId: z.string().uuid() });

export const stationActiveSchema = z.object({
  stationId: z.string().uuid(),
  isActive: z.coerce.boolean(),
});
