/**
 * Suy SERVER của một trận từ chính match_id.
 *
 * VÌ SAO KHÔNG DÙNG CỘT `region`: cột đó lưu CỤM VÙNG dùng để định tuyến API ("sea", "asia",
 * "americas", "europe"), không phải server. Cả VN2, SG2, TH2, TW2 và PH2 đều ghi xuống là
 * "sea" nên không phân biệt được server nào — đã kiểm chứng trên kho trận thật.
 *
 * Riot đặt match_id theo dạng "<PLATFORM>_<số>", vd "VN2_1571869105". Suy từ đó thì mọi trận
 * ĐÃ CRAWL TỪ TRƯỚC cũng nhận ra được server, không phải cào lại.
 */
export function platformFromMatchId(matchId: string): string | null {
  const idx = matchId.indexOf("_");
  if (idx <= 0) return null;
  const prefix = matchId.slice(0, idx).toLowerCase();
  // Mã platform của Riot luôn là chữ cái + có thể kèm một chữ số (na1, euw1, vn2, kr, ru).
  // Chặn ở đây để một match_id dị dạng không đẻ ra một "server" rác trong thống kê.
  return /^[a-z]{2,4}\d?$/.test(prefix) ? prefix : null;
}
