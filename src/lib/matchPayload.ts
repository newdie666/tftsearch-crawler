// Cách lưu một trận đấu trong bảng `matches`, và cách đọc nó ra.
//
// VẤN ĐỀ: response gốc của Riot nặng 18,2 KB/trận, mà ETL chỉ đọc tới một phần nhỏ. Đo trên 300
// trận thật trong kho: giữ đúng những field có người đọc rồi nén gzip còn 2,60 KB/trận — giảm
// 86%. Với 5.000 trận/ngày thì đó là chênh lệch giữa 91 MB và 13 MB mỗi ngày.
//
// GIỮ NGUYÊN TÊN TRƯỜNG CỦA RIOT thay vì đổi sang khoá ngắn. Khoá ngắn đo được 1,67 KB, tức tiết
// kiệm thêm 0,93 KB/trận nữa, nhưng đổi lại phải viết một bộ đọc riêng song song với
// getParticipants (dùng chung với ETL) và dữ liệu lưu xuống không còn tự mô tả — mở một bản ghi
// ra không đọc hiểu được nữa. Không đáng.
//
// NHỮNG GÌ BỊ BỎ: augment, metadata trận, và các field chỉ số của participant mà cả ETL lẫn UI
// đều không đọc. Giữ lại level/gold_left/damage/companion dù ETL chưa dùng — chúng gần như miễn
// phí sau khi nén và mở đường cho thống kê sau này. Riot ID thì BẮT BUỘC giữ: đó là nguồn tên
// người chơi miễn phí cho known_players, bỏ đi thì mỗi cái tên phải đổi bằng một request.
import zlib from "node:zlib";

/** Cột cần SELECT để đọc được một trận, bất kể nó lưu ở định dạng cũ hay mới. */
export const MATCH_PAYLOAD_COLUMNS = "raw_json, packed";

/** Dòng `matches` ở mức tối thiểu để unpackMatch làm việc được. */
export interface MatchPayloadRow {
  /** Định dạng CŨ: JSON đầy đủ dạng text. Rỗng với dòng ghi bởi bản mới. */
  raw_json: string | null;
  /** Định dạng MỚI: JSON đã cắt gọn, nén gzip. NULL với dòng cũ chưa chuyển đổi. */
  packed: Uint8Array | ArrayBuffer | null;
}

interface RiotUnit {
  character_id?: unknown;
  tier?: unknown;
  itemNames?: unknown;
}

interface RiotTrait {
  name?: unknown;
  num_units?: unknown;
  tier_current?: unknown;
}

interface RiotParticipant {
  puuid?: unknown;
  riotIdGameName?: unknown;
  riotIdTagline?: unknown;
  placement?: unknown;
  level?: unknown;
  gold_left?: unknown;
  last_round?: unknown;
  players_eliminated?: unknown;
  time_eliminated?: unknown;
  total_damage_to_players?: unknown;
  companion?: unknown;
  units?: RiotUnit[];
  traits?: RiotTrait[];
}

interface RiotMatch {
  info?: {
    queue_id?: unknown;
    game_version?: unknown;
    game_datetime?: unknown;
    tft_set_number?: unknown;
    tft_game_type?: unknown;
    participants?: RiotParticipant[];
  };
}

/** Giữ lại đúng phần có người đọc. Cấu trúc và tên trường y hệt response gốc. */
function trimMatch(match: unknown): RiotMatch {
  const info = (match as RiotMatch).info ?? {};
  return {
    info: {
      queue_id: info.queue_id,
      game_version: info.game_version,
      game_datetime: info.game_datetime,
      tft_set_number: info.tft_set_number,
      tft_game_type: info.tft_game_type,
      participants: (info.participants ?? []).map((p) => ({
        puuid: p.puuid,
        // Riot ID: nguồn tên người chơi miễn phí cho known_players (xem runPlayersEtl). Bỏ đi
        // thì mỗi cái tên trên bảng xếp hạng phải đổi bằng một request account-v1.
        riotIdGameName: p.riotIdGameName,
        riotIdTagline: p.riotIdTagline,
        placement: p.placement,
        level: p.level,
        gold_left: p.gold_left,
        last_round: p.last_round,
        players_eliminated: p.players_eliminated,
        time_eliminated: p.time_eliminated,
        total_damage_to_players: p.total_damage_to_players,
        companion: p.companion,
        units: (p.units ?? []).map((u) => ({
          character_id: u.character_id,
          tier: u.tier,
          itemNames: u.itemNames,
        })),
        traits: (p.traits ?? []).map((t) => ({
          name: t.name,
          num_units: t.num_units,
          tier_current: t.tier_current,
        })),
      })),
    },
  };
}

/** Cắt gọn rồi nén, ra đúng thứ ghi vào cột `packed`. */
export function packMatch(match: unknown): Buffer {
  // level 9: trận đấu ghi MỘT lần rồi đọc lại nhiều lần trong suốt mùa, nên đánh đổi CPU lúc
  // ghi để lấy dung lượng là đúng chiều. Chênh lệch thời gian ở cỡ vài mili-giây mỗi trận.
  return zlib.gzipSync(Buffer.from(JSON.stringify(trimMatch(match))), { level: 9 });
}

/**
 * Đọc một trận ra lại, chịu được CẢ HAI định dạng.
 *
 * Dòng cũ (raw_json đầy đủ) và dòng mới (packed) sống song song cho tới khi chạy xong script
 * chuyển đổi — và kể cả sau đó, hàm này vẫn phải chịu được dòng cũ vì không có gì đảm bảo mọi
 * môi trường đều đã chạy chuyển đổi.
 *
 * Trả null khi bản ghi hỏng, để nơi gọi bỏ qua đúng một trận thay vì làm chết cả lượt ETL.
 */
export function unpackMatch(row: MatchPayloadRow): unknown | null {
  try {
    if (row.packed) {
      const buf = row.packed instanceof Uint8Array ? Buffer.from(row.packed) : Buffer.from(new Uint8Array(row.packed));
      return JSON.parse(zlib.gunzipSync(buf).toString("utf8")) as unknown;
    }
    if (row.raw_json) return JSON.parse(row.raw_json) as unknown;
    return null;
  } catch {
    return null;
  }
}
