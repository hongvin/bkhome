/**
 * Malay / English lexicon for the myrapid.com.my media statements.
 *
 * Every table here was derived by reading the actual archived corpus
 * (`eval/out/raw-text.json`, 165 documents) rather than guessed. The regexes
 * are written against the real phrasing found there; `tests/eval/parser.test.ts`
 * pins the important ones with hand-written snippets.
 */

import type { IssueType, Severity } from "@/lib/contracts";

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/**
 * Malay line names -> frozen `LineId`. Order matters: the two-line
 * "AMPANG / SRI PETALING" form must be tested before the single-line forms or
 * it would be read as AG only.
 */
export interface LineRule {
  lineIds: string[];
  pattern: RegExp;
  note: string;
}

/** "AMPANG / SRI PETALING" is one combined corridor name for two LineIds. */
export const AMPANG_SRI_PETALING = /LALUAN\s+AMPANG\s*(?:\/|-|&|DAN)?\s*SRI\s+PETALING/;

export const LINE_RULES: LineRule[] = [
  {
    lineIds: ["AG", "PH"],
    pattern: /LALUAN\s+AMPANG\s*(?:\/|-|&|DAN)?\s*SRI\s+PETALING/,
    note: "Laluan Ampang / Sri Petaling (shared corridor name)",
  },
  { lineIds: ["KJ"], pattern: /LALUAN\s+KELANA\s+JAYA/, note: "Laluan Kelana Jaya" },
  { lineIds: ["KJ"], pattern: /LALUAN\s+KJ\b/, note: "Laluan KJ" },
  { lineIds: ["KJ"], pattern: /\bKJL\b/, note: "KJL = Kelana Jaya Line" },
  { lineIds: ["KGL"], pattern: /LALUAN\s+KAJANG/, note: "Laluan Kajang" },
  { lineIds: ["KGL"], pattern: /\bKGL\b/, note: "KGL" },
  { lineIds: ["PYL"], pattern: /LALUAN\s+PUTRAJAYA/, note: "Laluan Putrajaya" },
  { lineIds: ["PYL"], pattern: /\bPYL\b/, note: "PYL" },
  { lineIds: ["MR"], pattern: /LALUAN\s+MONOREL/, note: "Laluan Monorel" },
  { lineIds: ["MR"], pattern: /\bMONOREL\b/, note: "Monorel" },
  { lineIds: ["BRT"], pattern: /LALUAN\s+SUNWAY/, note: "BRT Laluan Sunway" },
  { lineIds: ["BRT"], pattern: /\bBRT\b/, note: "BRT" },
  { lineIds: ["SA"], pattern: /LALUAN\s+SHAH\s+ALAM/, note: "Laluan Shah Alam (LRT3)" },
  // Single-line Ampang / Sri Petaling, tested last so the combined form wins.
  { lineIds: ["AG"], pattern: /LALUAN\s+AMPANG/, note: "Laluan Ampang" },
  { lineIds: ["PH"], pattern: /LALUAN\s+SRI\s+PETALING/, note: "Laluan Sri Petaling" },
];

/** Which line a GTFS stop belongs to, parsed from `route_id` in stops.txt. */
export interface StationRecord {
  stopId: string;
  name: string;
  lineId: string;
  /** True when the PDF corpus writes this station differently from GTFS. */
  aliasOf?: string;
}

// ---------------------------------------------------------------------------
// Issue types — frozen enum from lib/contracts/signal.ts
// ---------------------------------------------------------------------------

/**
 * Weighted keyword evidence per issue type. A document's issue type is the
 * argmax of summed weights, with `ISSUE_PRIORITY` breaking ties. Weights were
 * tuned by inspecting the misclassifications on the real corpus.
 */
export interface IssueRule {
  issueType: IssueType;
  weight: number;
  pattern: RegExp;
  note: string;
}

export const ISSUE_RULES: IssueRule[] = [
  // Elevator / escalator — narrow, unambiguous vocabulary, high weight.
  { issueType: "ELEVATOR_FAULT", weight: 6, pattern: /\bLIF\b/, note: "lif (lift)" },
  { issueType: "ELEVATOR_FAULT", weight: 6, pattern: /ESKALATOR/, note: "eskalator" },
  {
    issueType: "ELEVATOR_FAULT",
    weight: 4,
    pattern: /ELEVATOR/,
    note: "elevator (EN)",
  },

  // Signal / train control.
  {
    issueType: "SIGNAL_FAULT",
    weight: 6,
    pattern: /SISTEM\s+SEMBOYAN/,
    note: "sistem semboyan",
  },
  { issueType: "SIGNAL_FAULT", weight: 6, pattern: /\bSEMBOYAN\b/, note: "semboyan" },
  {
    issueType: "SIGNAL_FAULT",
    weight: 5,
    pattern: /SISTEM\s+ISYARAT|\bISYARAT\b/,
    note: "sistem isyarat",
  },
  {
    issueType: "SIGNAL_FAULT",
    weight: 4,
    pattern: /SIGNAL(?:LING)?\s+(?:SYSTEM|FAULT)/,
    note: "signal system (EN)",
  },

  // Track / infrastructure.
  {
    issueType: "TRACK_FAULT",
    weight: 5,
    pattern: /SUIS\s+LANDASAN/,
    note: "suis landasan (track switch)",
  },
  {
    issueType: "TRACK_FAULT",
    weight: 4,
    pattern: /LANDASAN\s+(?:ROS AK|ROSAK|BENGKOK|RETAK|TERANGKAT|TIDAK\s+BERFUNGSI)/,
    note: "landasan rosak/bengkok",
  },
  { issueType: "TRACK_FAULT", weight: 3, pattern: /\bLANDASAN\b/, note: "landasan (track)" },
  { issueType: "TRACK_FAULT", weight: 3, pattern: /\bTREK\b/, note: "trek (track)" },
  {
    issueType: "TRACK_FAULT",
    weight: 4,
    pattern: /STRUKTUR\s+JEJAMBAT|JEJAMBAT/,
    note: "struktur jejambat (viaduct structure)",
  },
  { issueType: "TRACK_FAULT", weight: 3, pattern: /\bKINKED\b|PENJAJARAN/, note: "kinked alignment" },

  // Rolling stock.
  {
    issueType: "VEHICLE_BREAKDOWN",
    weight: 7,
    pattern: /TREN\s+TERKANDAS|TERKANDAS/,
    note: "tren terkandas (train stranded)",
  },
  {
    issueType: "VEHICLE_BREAKDOWN",
    weight: 5,
    pattern: /TREN\s+(?:ROS AK|ROSAK|GAGAL|TIDAK\s+DAPAT)/,
    note: "tren rosak",
  },
  {
    issueType: "VEHICLE_BREAKDOWN",
    weight: 4,
    pattern: /KEROSAKAN\s+(?:TREN|TEKNIKAL|KOMPONEN|SISTEM)/,
    note: "kerosakan tren/teknikal",
  },
  {
    issueType: "VEHICLE_BREAKDOWN",
    weight: 4,
    pattern: /MASALAH\s+(?:TEKNIKAL|MEKANIKAL|BREK|BEKALAN)/,
    note: "masalah teknikal/mekanikal/brek",
  },
  {
    issueType: "VEHICLE_BREAKDOWN",
    weight: 3,
    pattern: /KEGAGALAN\s+(?:KOMPONEN|SISTEM|BREK)/,
    note: "kegagalan komponen",
  },
  {
    issueType: "VEHICLE_BREAKDOWN",
    weight: 3,
    pattern: /KELUAR\s+DARIPADA\s+PERKHIDMATAN|DIKELUARKAN\s+DARIPADA\s+PERKHIDMATAN/,
    note: "train withdrawn from service",
  },
  {
    issueType: "VEHICLE_BREAKDOWN",
    weight: 3,
    pattern: /KEHILANGAN\s+(?:KUASA|SUMBER\s+KUASA)|KELUAR\s+KUASA/,
    note: "loss of traction power on a train",
  },
  { issueType: "VEHICLE_BREAKDOWN", weight: 3, pattern: /\bBREK\b/, note: "brek (brake)" },

  // Doors — platform screen doors and train doors.
  {
    issueType: "DOOR_FAULT",
    weight: 5,
    pattern: /PINTU\s+(?:PLATFORM|TREN|PSD)/,
    note: "pintu platform/tren",
  },

  // Crowding.
  { issueType: "CROWDING", weight: 4, pattern: /KESESAKAN|\bSESAK\b/, note: "kesesakan" },
  {
    issueType: "CROWDING",
    weight: 3,
    pattern: /PENUMPANG\s+(?:RAMAI|BERHIMPIT|TERLALU\s+BANYAK)/,
    note: "penumpang ramai",
  },

  // Weather.
  {
    issueType: "WEATHER",
    weight: 6,
    pattern: /POKOK\s+TUMBANG/,
    note: "pokok tumbang (tree fall) — weather-caused",
  },
  { issueType: "WEATHER", weight: 5, pattern: /\bBANJIR\b/, note: "banjir" },
  {
    issueType: "WEATHER",
    weight: 5,
    pattern: /ANGIN\s+KENCANG|RIBUT|PETIR|KILAT/,
    note: "angin kencang / petir",
  },
  { issueType: "WEATHER", weight: 4, pattern: /\bCUACA\b/, note: "cuaca" },

  // Road / right-of-way blocked.
  {
    issueType: "ROAD_BLOCKED",
    weight: 5,
    pattern: /PENCEROBOHAN|MENCEROBOH/,
    note: "pencerobohan (trespass on track)",
  },
  {
    issueType: "ROAD_BLOCKED",
    weight: 4,
    pattern: /JALAN\s+DITUTUP|MENGHALANG\s+JALAN|TERSANGKUT/,
    note: "road blocked / vehicle stuck",
  },
  {
    issueType: "ROAD_BLOCKED",
    weight: 3,
    pattern: /KEMALANGAN|NAHAS/,
    note: "kemalangan (accident)",
  },

  // Delay — the generic fallback vocabulary.
  { issueType: "DELAY", weight: 3, pattern: /KELEWATAN|MENGALAMI\s+KELEWATAN/, note: "kelewatan" },
  { issueType: "DELAY", weight: 3, pattern: /JEJAS\s+JADUAL/, note: "jejas jadual" },
  { issueType: "DELAY", weight: 2, pattern: /\bLEWAT\b|\bTERLAMBAT\b/, note: "lewat" },
  {
    issueType: "DELAY",
    weight: 2,
    pattern: /BERGERAK\s+LEBIH\s+PERLAHAN|PERLAHAN/,
    note: "train running slow",
  },
];

/** Deterministic tie-break when two issue types score equally. */
export const ISSUE_PRIORITY: IssueType[] = [
  "VEHICLE_BREAKDOWN",
  "SIGNAL_FAULT",
  "TRACK_FAULT",
  "ELEVATOR_FAULT",
  "DOOR_FAULT",
  "WEATHER",
  "ROAD_BLOCKED",
  "CROWDING",
  "DELAY",
  "UNKNOWN",
];

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export interface SeverityRule {
  severity: Severity;
  weight: number;
  pattern: RegExp;
  note: string;
}

export const SEVERITY_RULES: SeverityRule[] = [
  {
    severity: "SEVERE",
    weight: 8,
    pattern: /PERKHIDMATAN\s+(?:DIHENTIKAN|DIBERHENTIKAN|TERHENTI|TIDAK\s+DAPAT\s+BEROPERASI)/,
    note: "service halted",
  },
  {
    severity: "SEVERE",
    weight: 7,
    pattern: /PENUTUPAN\s+(?:SEMENTARA\s+)?STESEN|STESEN\s+(?:DITUTUP|DIBUKA\s+SEMULA)/,
    note: "station closed",
  },
  { severity: "SEVERE", weight: 6, pattern: /DITUTUP\s+SEMENTARA|PENUTUPAN/, note: "closure" },
  { severity: "SEVERE", weight: 5, pattern: /TREN\s+TERKANDAS|TERKANDAS/, note: "train stranded" },
  {
    severity: "SEVERE",
    weight: 4,
    pattern: /BERPATAH\s+BALIK|PERKHIDMATAN\s+ULANG-ALIK|PERKHIDMATAN\s+TREN\s+PERANTARA/,
    note: "short-turn / shuttle operation",
  },
  {
    severity: "MAJOR",
    weight: 5,
    pattern: /GANGGUAN\s+(?:PERKHIDMATAN|TEKNIKAL|SISTEM|BEKALAN|SUIS|ISYARAT)/,
    note: "gangguan perkhidmatan",
  },
  { severity: "MAJOR", weight: 4, pattern: /TERJEJAS|JEJAS\s+JADUAL/, note: "terjejas" },
  {
    severity: "MAJOR",
    weight: 4,
    pattern: /SATU\s+LANDASAN|SINGLE\s+TRACK|LANDASAN\s+TUNGGAL/,
    note: "single-track working",
  },
  {
    severity: "MAJOR",
    weight: 3,
    pattern: /PERKHIDMATAN\s+TERHAD|KEKERAPAN\s+BERKURANGAN|MENGURANGKAN\s+JUMLAH\s+TREN/,
    note: "reduced service",
  },
  { severity: "MAJOR", weight: 3, pattern: /KESESAKAN\s+(?:YANG\s+)?TERUK|SESAK/, note: "severe crowding" },
  { severity: "MINOR", weight: 2, pattern: /KELEWATAN|LEWAT/, note: "delay" },
  { severity: "MINOR", weight: 2, pattern: /GANGGUAN\s+SEMENTARA/, note: "temporary disruption" },
  { severity: "INFO", weight: 1, pattern: /PENGUMUMAN|MAKLUMAN|ADVISORY/, note: "advisory" },
];

export const SEVERITY_ORDER: Severity[] = ["INFO", "MINOR", "MAJOR", "SEVERE"];

// ---------------------------------------------------------------------------
// Document-kind markers
// ---------------------------------------------------------------------------

/** Vocabulary that means "a service disruption happened". */
export const DISRUPTION_MARKERS: RegExp[] = [
  /GANGGUAN/,
  /TERJEJAS/,
  /TERKANDAS/,
  /KELEWATAN/,
  /KEROSAKAN/,
  /TERHENTI/,
  /DIHENTIKAN/,
  /PENUTUPAN/,
  /DITUTUP/,
  /INSIDEN/,
  /KEBAKARAN/,
  /TERBAKAR/,
  /KEMALANGAN/,
  /NAHAS/,
  /PENCEROBOHAN/,
  /TIDAK\s+BERFUNGSI/,
  /TIDAK\s+DAPAT\s+BEROPERASI/,
  /PULIH\s+SEPENUHNYA/,
  /KEMBALI\s+PULIH/,
  /SATU\s+LANDASAN/,
  /SINGLE\s+TRACK/,
];

/**
 * Vocabulary for a *planned* change: works announced before they happen, not
 * an unplanned reliability failure. These are excluded from the positive class
 * and counted separately — see `DocKind` in `./label`.
 */
export const PLANNED_MARKERS: RegExp[] = [
  /KERJA-KERJA\s+NAIK\s+TARAF/,
  /KERJA-KERJA\s+BAIK\s+PULIH/,
  /KERJA\s+BAIK\s+PULIH/,
  /PENJADUALAN\s+SEMULA\s+KERJA/,
  /MIGRASI/,
  /SESI\s+UJIAN|UJIAN\s+(?:SISTEM|LANJUTAN|PERCUBAAN|MIGRASI)/,
  /PEMERIKSAAN\s+PERAKUAN\s+BOMBA/,
  /PERAKUAN\s+BOMBA/,
  /PEMBUKAAN\s+SEMULA/,
  /AKAN\s+DITUTUP|AKAN\s+DIJALANKAN|AKAN\s+DILAKSANAKAN/,
];

/**
 * Vocabulary for documents that are about the operator as an organisation, a
 * campaign, an event, a tender or a policy — not about a service failure.
 *
 * Split into two tiers by decisiveness. A `STRONG` marker alone is enough to
 * call a document a non-incident; `WEAK` markers must outnumber the disruption
 * markers. Each entry was added because a real document in the corpus was
 * misclassified without it; the comment names that document.
 */
export const STRONG_NON_INCIDENT_MARKERS: RegExp[] = [
  /TAWARAN|SEBUT\s+HARGA|PELANTIKAN|PUCUK\s+PIMPINAN/,
  /KEMPEN/,
  /TAMBANG\s+PERCUMA|PERCUMA\s+SEBULAN/,
  /DISKAUN|BELI\s+1\s+PERCUMA\s+1/,
  /JOM\s*NAIK/,
  /EKSPLORASI\s+MERDEKA/,
  /MOTOGP/,
  /\bBRT\s*RUN\b|LARIAN/,
  /PERLAWANAN|PIALA|BOLA\s+SEPAK/,
  /AMBANG\s+TAHUN|HARI\s+RAYA|RAMADAN|THAIPUSAM|MERDEKA|HARI\s+MENGUNDI/,
  /REKOD\s+(?:PENUMPANG|JUMLAH)|PENUMPANG\s+TERTINGGI/,
  /PENGIKTIRAFAN|ANUGERAH|PENGHARGAAN|TAHNIAH/,
  /LEMBARAN\s+BAHARU|LAPORAN\s+TAHUNAN/,
  /SIFAR\s+KEMALANGAN|KESELAMATAN\s+JALAN\s+RAYA|KESEDIAAN\s+DAN\s+SIAP\s+SIAGA/,
  /VAKSIN|\bPPV\b|COVID/,
  /OKU|SMILE|MYCITY|FIT\s+RAPID/,
  /KAD\s+DEBIT|PEMBAYARAN/,
  /PULSE|APLIKASI/,
  /KELESTARIAN|EKOSISTEM\s+MARIN|PENYU/,
  /TULAR|PALSU|MENAFIKAN/,
  /PENSTRUKTURAN\s+SEMULA\s+LALUAN/,
  // --- added after reviewing the first rule-based pass over the real corpus ---
  /** "UJIAN MENUNJUKKAN PETANDA POSITIF", "UJIAN-UJIAN LANJUTAN GIAT DIJALANKAN" */
  /UJIAN(?:-UJIAN)?\s+(?:MENUNJUKKAN|LANJUTAN|PERCUBAAN|SISTEM|MIGRASI)/,
  /** "HARI PERTAMA PEMBUKAAN SEMULA LRT LALUAN KELANA JAYA BERJALAN LANCAR" */
  /PEMBUKAAN\s+SEMULA|DIBUKA\s+SEPENUHNYA|BERJALAN\s+LANCAR/,
  /** "LANJUTAN OPERASI STESEN LRT BUKIT JALIL", "RAPID KL LANJUT WAKTU OPERASI" */
  /LANJUTAN\s+OPERASI|LANJUT\s+(?:WAKTU|PERKHIDMATAN|TEMPOH)|WAKTU\s+OPERASI/,
  /** "KEMENTERIAN PENGANGKUTAN MENGAMBIL MAKLUM KEMAJUAN PELAKSANAAN" */
  /MENGAMBIL\s+MAKLUM|KEMAJUAN\s+PELAKSANAAN|PELAKSANAAN\s+PROJEK/,
  /** "SASARAN 200,000 PURATA PENGGUNAAN HARIAN" */
  /SASARAN\s+\d|PURATA\s+PENGGUNAAN\s+HARIAN|JUMLAH\s+PENGGUNA/,
  /** "INSIDEN KEBAKARAN SEBUAH KERETA DI DALAM KOMPLEKS PARKIR" — not a service disruption */
  /KOMPLEKS\s+PARKIR|SEBUAH\s+KERETA\b/,
  /** "PRASARANA AKAN MENINGKATKAN KETELUSAN DAN KEBOLEHPERCAYAAN" */
  /MENINGKATKAN\s+KETELUSAN|KEBOLEHPERCAYAAN|INTEGRITI/,
  /** "PEMBEKAL BAGI MEMPERCEPATKAN PROSES PENGGANTIAN KOMPONEN" */
  /PENGGANTIAN\s+KOMPONEN|MEMPERCEPATKAN\s+PROSES/,
  /** "PENAMBAHBAIKAN PERKHIDMATAN", "GIAT MENJALANKAN KERJA-KERJA BAIK PULIH FASILITI" */
  /PENAMBAHBAIKAN\s+(?:PERKHIDMATAN|OPERASI|FASILITI)/,
  /KERJA-KERJA\s+BAIK\s+PULIH\s+FASILITI|BAIK\s+PULIH\s+FASILITI/,
];

/** Corroborating, not decisive on their own. */
export const WEAK_NON_INCIDENT_MARKERS: RegExp[] = [
  /\bPAS\b/,
  /KOLABORASI|MEMORANDUM\s+PERSEFAHAMAN|KERJASAMA/,
  /LAPORAN|SIASATAN\s+(?:MENYELURUH|DALAMAN)/,
  /DRT\b|DEMAND\s+RESPONSIVE/,
  /LORONG\s+BAS|SKIP\s+STOP|BAS\s+PERANTARA\s+(?:PERCUMA\s+)?(?:BAHARU|T250|T545)/,
  /JENAYAH|SUSPEK|POLIS\s+BANTUAN|TANGKAP/,
  /** "PRASARANA TINGKAT KEKERAPAN TREN DAN BAS MULAI 1 APRIL" */
  /TINGKAT\s+KEKERAPAN|MENINGKATKAN\s+KEKERAPAN|KEKERAPAN\s+TREN\s+DAN\s+BAS/,
  /** "PENGURANGAN JUMLAH TREN YANG BEROPERASI" is a planned service change */
  /PENGURANGAN\s+JUMLAH\s+TREN/,
  /PEMBUKAAN\s+(?:SEMULA\s+)?(?:STESEN|LALUAN|PERKHIDMATAN)/,
];

/** Boilerplate that appears in nearly every statement; stripped before headline scoring. */
export const BOILERPLATE: RegExp[] = [
  /SIARAN\s+MEDIA/,
  /KENYATAAN\s+MEDIA/,
  /UNTUK\s+SIARAN\s+(?:SEGERA|SEGARA)/,
  /KUALA\s+LUMPUR,?\s*\d{1,2}\s+[A-Za-z]+\s*\d{0,4}/,
  /DIKELUARKAN\s+OLEH[^.]*/,
  /SEBARANG\s+PERTANYAAN[^.]*/,
  /TAMAT/,
  /PRASARANA\s+MALAYSIA\s+BERHAD/,
  /RAPID\s+RAIL\s+SDN\s+BHD/,
  /RAPID\s+BUS\s+SDN\s+BHD/,
  /RAPID\s+KL/,
];
