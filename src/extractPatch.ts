export function extractPatch(
  gameVersion: string | null | undefined,
  setNumber?: number | null,
): string {
  /*
   * Từ Set 18 LUÔN khoá theo set, kể cả nếu trận nào đó còn mang số bản thật — số bản thật của
   * từng trận nằm ở cột matches.game_patch (xem scripts/lib/livePatch.ts).
   *
   * Lưu ý khi đọc khoá dạng số bản ("16.18"): đó KHÔNG phải trận Set 18 bị lạc. Đã kiểm tra trận
   * duy nhất mang khoá này (NA1_5640274803): queue 6110, tft_set_number = 17 — một chế độ đặc
   * biệt chạy nội dung set cũ, nên tách thành khoá riêng là đúng. Trang xếp hạng chỉ liệt kê khoá
   * của đúng chế độ đang xem (xem getDistinctPatches) nên khoá này không lọt vào ô Set nữa.
   */
  if (typeof setNumber === "number" && Number.isFinite(setNumber) && setNumber >= 18) return `S${setNumber}`;
  const match = gameVersion?.match(/(\d+\.\d+)/);
  if (match) return match[1];
  if (typeof setNumber === "number" && Number.isFinite(setNumber)) return `S${setNumber}`;
  return "unknown";
}
