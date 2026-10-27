import type { EmrRecordType, Vitals } from '@/modules/clinic/service';

export type Scope = { organizationSlug: string; branchSlug: string };

export type EmrPermissions = {
  /** clinic.emr.write */
  write: boolean;
  /** clinic.prescription.write AND the signed-in user is a doctor here */
  prescribe: boolean;
  /** clinic.prescription.write (share; cancel is the issuing doctor's or a manager's) */
  prescriptionWrite: boolean;
  /** clinic.patient.manage */
  editPatient: boolean;
  /** clinic.patient.read */
  searchPatients: boolean;
  /** clinic.doctor.manage */
  manageDoctors: boolean;
};

export const RECORD_LABELS: Record<EmrRecordType, string> = {
  note: 'ملاحظة سريرية',
  diagnosis: 'تشخيص',
  vitals: 'علامات حيوية',
  history: 'تاريخ مرضي',
  attachment: 'مرفق',
  amendment: 'تصحيح',
};

/** Field, label, unit, the database's own range, and the usual adult range for a flag. */
export const VITALS: {
  key: keyof Vitals; label: string; unit: string; min: number; max: number; step: number;
  normal?: [number, number];
}[] = [
  { key: 'systolicMmhg', label: 'الضغط الانقباضي', unit: 'mmHg', min: 50, max: 260, step: 1, normal: [90, 139] },
  { key: 'diastolicMmhg', label: 'الضغط الانبساطي', unit: 'mmHg', min: 30, max: 160, step: 1, normal: [60, 89] },
  { key: 'pulseBpm', label: 'النبض', unit: 'نبضة/د', min: 20, max: 250, step: 1, normal: [60, 100] },
  { key: 'temperatureC', label: 'الحرارة', unit: '°C', min: 30, max: 45, step: 0.1, normal: [36.1, 37.5] },
  { key: 'spo2Percent', label: 'تشبع الأكسجين', unit: '%', min: 50, max: 100, step: 1, normal: [95, 100] },
  { key: 'respiratoryRate', label: 'معدل التنفس', unit: '/د', min: 5, max: 80, step: 1, normal: [12, 20] },
  { key: 'glucoseMgDl', label: 'السكر', unit: 'mg/dL', min: 10, max: 1000, step: 1, normal: [70, 140] },
  { key: 'weightKg', label: 'الوزن', unit: 'كجم', min: 0.3, max: 400, step: 0.1 },
  { key: 'heightCm', label: 'الطول', unit: 'سم', min: 20, max: 250, step: 0.5 },
];

export function outOfRange(key: keyof Vitals, value: number | null): boolean {
  if (value === null) return false;
  const v = VITALS.find((x) => x.key === key);
  return !!v?.normal && (value < v.normal[0] || value > v.normal[1]);
}

export const DOSAGE_FORMS = ['أقراص', 'كبسولات', 'شراب', 'حقن', 'كريم', 'مرهم', 'نقط', 'بخاخ', 'لبوس', 'أكياس'];
export const FREQUENCIES = ['مرة يوميًا', 'مرتين يوميًا', '3 مرات يوميًا', 'كل 8 ساعات', 'كل 12 ساعة', 'قبل النوم', 'عند اللزوم'];
export const ROUTES = ['بالفم', 'موضعي', 'عضل', 'وريد', 'تحت الجلد', 'استنشاق', 'بالعين', 'بالأذن'];

export function failure(r: { code: string; error: string }): string {
  if (r.code === 'forbidden' || r.code === 'not_found') return 'لا تملك صلاحية هذا الإجراء.';
  return r.error;
}

export function formatDateTime(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso));
}

export function formatDate(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeZone }).format(new Date(iso));
}
