import type { Client } from "@libsql/client";

/**
 * Bản cập nhật (patch) cho từng trận, vì Riot không còn cho biết điều đó.
 *
 * BỐI CẢNH (đo thật): từ Set 18, `info.game_version` của Match API là đúng chuỗi
 * "TFT Unreal Version ?.?.?.?" cho toàn bộ trận — không còn số bản.
 *
 * NGUỒN — đều là dữ liệu của chính Riot, đã đối chiếu tay:
 *   - Danh sách bản: Data Dragon `versions.json` (vd "16.18.1").
 *   - Bản thuộc SET nào: `tft-champion.json` của đúng bản đó. Set mới chỉ xuất hiện từ bản nó ra
 *     mắt — đo được: 16.16.1 chứa tới TFTSet17, 16.17.1 bắt đầu có TFTSet18. Nên 16.17 là bản
 *     đầu tiên của Set 18.
 *   - Thời điểm ra mắt: header Last-Modified của chính file đó trên CDN Data Dragon — 16.16.1
 *     11/08 19:13, 16.17.1 25/08 19:06, 16.18.1 09/09 19:09 (UTC), cách nhau đúng 2 tuần, khớp
 *     lịch ra bản.
 *
 * NHÃN HIỂN THỊ theo kiểu các trang thống kê TFT khác: bản thứ n của Set 18 là "18.n" (16.17 →
 * 18.1, 16.18 → 18.2). Số chính thức "16.18" vẫn được lưu làm khoá; nhãn chỉ để người đọc hiểu.
 * Nhãn chỉ được gán cho set mà hệ thống THẤY được bản đầu tiên (thấy được bản cuối của set trước
 * ngay trước nó) — set cũ hơn không biết bản đầu là bản nào nên để trống, không đánh số bừa.
 */

const DDRAGON = "https://ddragon.leagueoflegends.com";

/*
 * MỐC ĐỔI BẢN CỦA TỪNG SERVER.
 *
 * Mỗi server lên bản vào một giờ khác nhau, và không trùng giờ Data Dragon xuất bản file. Bản trước
 * đây bỏ trống mọi trận trong khoảng 12 giờ trước → 24 giờ sau mốc Data Dragon để khỏi gắn nhầm —
 * đo thật thì khoảng đó nuốt mất 896 trận (18% dữ liệu Set 18 lúc ấy). Người dùng chọn cách khác:
 *   1. Server có mốc riêng trong bảng patch_cutovers (suy từ khoảng lặng bảo trì trong dữ liệu
 *      trận, xem scripts/data/detectPatchCutovers.ts) -> dùng mốc đó.
 *   2. Không có -> dùng giờ phát hành trên Data Dragon.
 * Riot KHÔNG có nguồn giờ bảo trì theo lịch sử: tft/status/v1/platform-data chỉ trả lượt bảo trì
 * đang diễn ra (đã gọi thử cả vn2, kr, euw1, na1 — đều rỗng khi không có bảo trì).
 */

/** "16.18.1" -> "16.18". null nếu không đúng dạng số bản. */
export function toPatch(version: string): string | null {
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  return m ? `${m[1]}.${m[2]}` : null;
}

export interface PatchVersion {
  /** Số chính thức, vd "16.18". */
  patch: string;
  setNumber: number | null;
  /** Nhãn theo set, vd "18.2". null khi không xác định được bản đầu của set. */
  label: string | null;
  /** Epoch ms, theo Last-Modified của Data Dragon. */
  releasedAt: number;
  /** Mốc lên bản riêng theo server ("vn2" -> epoch ms), từ bảng patch_cutovers. */
  cutovers: Record<string, number>;
}

async function fetchVersionDetail(
  version: string,
  timeoutMs: number,
): Promise<{ setNumber: number | null; releasedAt: number | null }> {
  const url = `${DDRAGON}/cdn/${version}/data/en_US/tft-champion.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return { setNumber: null, releasedAt: null };
  const lastModified = res.headers.get("last-modified");
  const releasedAt = lastModified ? Date.parse(lastModified) : NaN;
  const json = (await res.json()) as { data?: Record<string, unknown> };
  let maxSet: number | null = null;
  for (const key of Object.keys(json.data ?? {})) {
    const m = /TFTSet(\d+)/.exec(key);
    if (m) maxSet = Math.max(maxSet ?? 0, Number(m[1]));
  }
  return { setNumber: maxSet, releasedAt: Number.isFinite(releasedAt) ? releasedAt : null };
}

/**
 * Đồng bộ bảng patch_versions với Data Dragon.
 *
 * Chỉ tải chi tiết cho bản CHƯA có trong bảng, đi lùi từ bản mới nhất và dừng ở bản đầu tiên đã
 * biết — nên lượt thường chỉ tốn một request versions.json nhỏ, và chỉ tải thêm đúng lúc Riot ra
 * bản mới (hai tuần một lần). `maxNew` chặn trên để một lượt crawl (~25 giây ngân sách) không bao
 * giờ bị kéo dài vì việc phụ này.
 */
export async function syncPatchVersions(
  db: Client,
  opts: { maxNew?: number; timeoutMs?: number } = {},
): Promise<PatchVersion[]> {
  const maxNew = opts.maxNew ?? 3;
  const timeoutMs = opts.timeoutMs ?? 4000;

  const known = await loadPatchVersions(db);
  const knownPatches = new Set(known.map((v) => v.patch));

  try {
    const res = await fetch(`${DDRAGON}/api/versions.json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const versions = (await res.json()) as unknown;
      if (Array.isArray(versions)) {
        let added = 0;
        for (const v of versions) {
          if (typeof v !== "string") continue;
          const patch = toPatch(v);
          if (!patch) continue;
          if (knownPatches.has(patch)) break;
          if (added >= maxNew) break;
          const detail = await fetchVersionDetail(v, timeoutMs);
          if (detail.releasedAt === null) continue;
          await db.execute({
            sql: `INSERT OR REPLACE INTO patch_versions (patch, set_number, label, released_at)
                  VALUES (?, ?, NULL, ?)`,
            args: [patch, detail.setNumber, detail.releasedAt],
          });
          knownPatches.add(patch);
          added++;
        }
      }
    }
  } catch {
    // Mạng lỗi: dùng tiếp bảng đang có. Việc này không bao giờ được làm gãy lượt crawl.
  }

  await relabel(db);
  return loadPatchVersions(db);
}

/**
 * Đánh số lại nhãn "set.n". Chỉ đánh cho set mà bản đầu tiên của nó đứng NGAY SAU một bản thuộc
 * set trước — tức hệ thống thấy được lúc chuyển set, nên biết chắc bản nào là bản đầu.
 */
async function relabel(db: Client): Promise<void> {
  const rows = (await loadPatchVersions(db)).sort((a, b) => a.releasedAt - b.releasedAt);
  const labels = new Map<string, string | null>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.setNumber === null) {
      labels.set(row.patch, null);
      continue;
    }
    const sameSet = rows.filter((r) => r.setNumber === row.setNumber);
    const first = sameSet[0];
    const firstIndex = rows.indexOf(first);
    const sawTransition = firstIndex > 0 && rows[firstIndex - 1].setNumber !== row.setNumber;
    labels.set(row.patch, sawTransition ? `${row.setNumber}.${sameSet.indexOf(row) + 1}` : null);
  }
  await db.batch(
    [...labels].map(([patch, label]) => ({
      sql: "UPDATE patch_versions SET label = ? WHERE patch = ?",
      args: [label, patch],
    })),
    "write",
  );
}

export async function loadPatchVersions(db: Client): Promise<PatchVersion[]> {
  const [res, cut] = await Promise.all([
    db.execute("SELECT patch, set_number, label, released_at FROM patch_versions ORDER BY released_at ASC"),
    db.execute("SELECT platform, patch, cutover_at FROM patch_cutovers"),
  ]);
  const cutovers = new Map<string, Record<string, number>>();
  for (const r of cut.rows as unknown as { platform: string; patch: string; cutover_at: number }[]) {
    const byPlatform = cutovers.get(String(r.patch)) ?? {};
    byPlatform[String(r.platform)] = Number(r.cutover_at);
    cutovers.set(String(r.patch), byPlatform);
  }
  return (res.rows as unknown as { patch: string; set_number: number | null; label: string | null; released_at: number }[]).map(
    (r) => ({
      patch: String(r.patch),
      setNumber: r.set_number === null ? null : Number(r.set_number),
      label: r.label === null ? null : String(r.label),
      releasedAt: Number(r.released_at),
      cutovers: cutovers.get(String(r.patch)) ?? {},
    }),
  );
}

/** Lúc bản bắt đầu chạy trên một server: mốc riêng của server nếu có, không thì giờ Data Dragon. */
export function patchStartFor(version: PatchVersion, platform: string | null | undefined): number {
  return (platform && version.cutovers[platform]) || version.releasedAt;
}

/**
 * Bản đang chạy trên server `platform` lúc trận diễn ra = bản mới nhất đã bắt đầu trước giờ trận.
 * null chỉ khi trận cũ hơn mọi bản đã biết.
 */
export function patchAt(
  versions: PatchVersion[],
  gameDatetimeMs: number | null | undefined,
  platform: string | null | undefined,
): string | null {
  if (!gameDatetimeMs) return null;
  let current: { patch: string; start: number } | null = null;
  for (const v of versions) {
    const start = patchStartFor(v, platform);
    if (start <= gameDatetimeMs && (!current || start > current.start)) current = { patch: v.patch, start };
  }
  return current?.patch ?? null;
}
