// Logic crawl thuần, không đọc CLI/env, không process.exit — để dùng chung giữa:
//  - scripts/crawler/crawlMatches.ts (chạy tay / npm run crawl)
//  - scripts/crawler/scheduleCrawl.ts (node-cron, chạy định kỳ trên server hiện tại)
//  - src/app/api/cron/crawl/route.ts (Vercel Cron, khi deploy lên Vercel)
import { getDb, getDbWithSchema } from "./db";
import { extractPatch } from "./extractPatch";
import { patchAt, syncPatchVersions } from "./lib/livePatch";
import { platformFromMatchId } from "./lib/matchPlatform";
import { RiotClient, accountRegionForPlatform, regionForPlatform, type Platform, type Region } from "./lib/riotClient";
import { packMatch } from "./lib/matchPayload";

export type LeagueTier = "challenger" | "grandmaster" | "master";

const LEAGUE_TIERS: LeagueTier[] = ["challenger", "grandmaster", "master"];

/**
 * Đọc danh sách hạng từ chuỗi cấu hình, vd "challenger,grandmaster".
 *
 * Bỏ qua giá trị lạ thay vì ném lỗi: chuỗi này đến từ biến môi trường và query string, và một
 * ký tự thừa trong cấu hình cron không đáng để làm chết cả lượt crawl. Không nhận ra hạng nào
 * thì lùi về "challenger" — hành vi cũ.
 */
export function parseTiers(value: string | null | undefined): LeagueTier[] {
  const parsed = (value ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is LeagueTier => (LEAGUE_TIERS as string[]).includes(t));
  // Giữ thứ tự chuẩn và loại trùng, để log đọc ra luôn giống nhau dù cấu hình viết kiểu gì.
  const unique = LEAGUE_TIERS.filter((t) => parsed.includes(t));
  return unique.length > 0 ? unique : ["challenger"];
}

export interface RunCrawlOptions {
  apiKey: string;
  platform: Platform;
  /**
   * Các hạng lấy người chơi để dò trận. Gộp NHIỀU hạng là cách rẻ nhất để tăng số trận mới:
   * mỗi hạng chỉ tốn thêm ĐÚNG MỘT request lấy bảng xếp hạng, nhưng nhân số tài khoản có thể
   * dò lên nhiều lần — mà tỉ lệ trận trùng chính là hệ quả của việc quét đi quét lại một nhóm
   * tài khoản quá nhỏ (đo thật trên VN2: 156 người Thách Đấu, 34/43 id ứng viên đã có sẵn).
   */
  tiers: LeagueTier[];
  queue?: string;
  limit: number;
  matchesPerPlayer?: number;
  onLog?: (msg: string) => void;
  /**
   * Chạy kiểm tra / di trú schema trước khi crawl (~20 lệnh tới Turso). Cron trên Vercel KHÔNG bật (17/09/2026): schema
   * do ETL giữ (chạy 3 lần/ngày) nên lượt crawl nào cũng kiểm lại là tốn thời gian vô ích; route tự bật lại và chạy
   * lần nữa khi gặp lỗi thiếu bảng/cột (xem isMissingSchemaError). Script chạy tay mặc định bật.
   */
  ensureSchema?: boolean;
}

/** Lỗi SQLite khi schema chưa có bảng / cột mà crawl cần — dấu hiệu phải chạy getDbWithSchema. */
export function isMissingSchemaError(err: unknown): boolean {
  return /no such (table|column)/i.test((err as Error)?.message ?? "");
}

export interface RunCrawlResult {
  platform: Platform;
  region: Region;
  playersFound: number;
  candidateMatchIds: number;
  fetched: number;
  skippedExisting: number;
  /** Số tên người chơi tra thêm được cho bảng xếp hạng trong lượt này. */
  namesResolved: number;
}

/** Fisher-Yates trên một BẢN SAO — không đụng vào mảng gốc của caller. */
function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}


/**
 * Trần số puuid tra tên mỗi lượt crawl.
 *
 * Đây chỉ là chặn trên; thứ thật sự quyết định là RUN_BUDGET_MS bên dưới — vòng lặp dừng ngay
 * khi hết giờ, nên trên server mới (chưa có tên nào) nó sẽ tra được ít hơn 20 và để phần còn
 * lại cho lượt sau. Giữ con số này để một server có hàng nghìn puuid thiếu tên cũng không nuốt
 * trọn ngân sách request của cụm vùng.
 */
const NAME_BACKFILL_PER_RUN = 20;

/**
 * Ngân sách thời gian của cả lượt crawl, tính bằng mili-giây.
 *
 * Trần thật là 30 GIÂY — mốc cron-job.org đóng kết nối — chứ không phải 60 giây của Vercel.
 * Đặt 25 giây để còn chỗ cho độ trễ mạng và cho lệnh ghi cuối cùng.
 *
 * VÌ SAO CẦN: trên một server MỚI, chưa trận nào trùng nên phải tải đủ 40 trận, và chưa tên nào
 * trong kho nên phải tra đủ 20 tên — đo thật trên kr/na1/euw1 ra 36-41 giây, vượt trần. Server
 * đã chạy lâu thì phần lớn trận đã có sẵn và tên đã đủ, nên chỉ mất ~19 giây. Một hằng số
 * CRAWL_LIMIT duy nhất không thể vừa cho cả hai trạng thái đó; canh theo đồng hồ thì tự đúng.
 */
const RUN_BUDGET_MS = 25_000;

/**
 * Chỉ cần tên cho phần đầu bảng. Bảng xếp hạng hiển thị 100 dòng (MAX_ROWS ở src/lib/leaderboard.ts);
 * lấy dư tới 150 để thứ hạng xê dịch giữa hai lượt vẫn không lộ ra dòng trống.
 */
const LEADERBOARD_DEPTH = 150;

/**
 * Điền dần tên người chơi cho bảng xếp hạng.
 *
 * VÌ SAO PHẢI LÀM: league-v1 chỉ trả về puuid. Tên phải hỏi riêng account-v1, mỗi puuid một
 * request. Tra toàn bộ ngay lúc mở trang xếp hạng thì mỗi lượt xem tốn cả trăm request và
 * trang tải rất chậm; làm dần ở đây thì chi phí trải ra, và sau vài lượt crawl là gần như
 * kín tên, sau đó gần như không còn gì để tra nữa.
 *
 * Dùng lại chính bảng xếp hạng mà crawl VỪA tải để chọn tướng đi tìm, nên không tốn thêm
 * request nào cho việc lấy danh sách.
 */
async function backfillLeaderboardNames(
  db: Awaited<ReturnType<typeof getDb>>,
  client: RiotClient,
  platform: Platform,
  entries: { puuid: string; leaguePoints: number }[],
  log: (msg: string) => void,
  /** Mốc thời gian phải dừng, tính theo Date.now(). Hết giờ thì bỏ dở, lượt sau tra tiếp. */
  deadline: number,
): Promise<number> {
  if (Date.now() >= deadline) {
    log("[crawl] Hết ngân sách thời gian, để phần tra tên cho lượt sau.");
    return 0;
  }
  const top = [...entries].sort((a, b) => b.leaguePoints - a.leaguePoints).slice(0, LEADERBOARD_DEPTH);
  if (top.length === 0) return 0;

  const placeholders = top.map(() => "?").join(",");
  const known = await db.execute({
    sql: `SELECT puuid FROM known_players WHERE puuid IN (${placeholders})`,
    args: top.map((e) => e.puuid),
  });
  const haveName = new Set((known.rows as unknown as { puuid: string }[]).map((r) => r.puuid));

  const missing = top.filter((e) => !haveName.has(e.puuid)).slice(0, NAME_BACKFILL_PER_RUN);
  if (missing.length === 0) {
    log("[crawl] Bảng xếp hạng đã đủ tên, không cần tra thêm.");
    return 0;
  }

  const accountRegion = accountRegionForPlatform(platform);
  let resolved = 0;
  for (const entry of missing) {
    // Dừng giữa chừng khi hết giờ. Tên là việc tích luỹ dần qua nhiều lượt, bỏ dở không mất gì;
    // còn để lượt chạy vượt 30 giây thì cron-job.org báo đỏ và người vận hành không biết vì sao.
    if (Date.now() >= deadline) {
      log(`[crawl] Dừng tra tên vì hết ngân sách thời gian (đã tra ${resolved}).`);
      break;
    }
    try {
      const account = await client.getAccountByPuuid(accountRegion, entry.puuid);
      if (!account.gameName || !account.tagLine) continue;
      await db.execute({
        sql: `INSERT INTO known_players (puuid, game_name, tag_line, platform, updated_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(puuid) DO UPDATE SET game_name = excluded.game_name, tag_line = excluded.tag_line, updated_at = excluded.updated_at`,
        args: [account.puuid, account.gameName, account.tagLine, platform, new Date().toISOString()],
      });
      resolved++;
    } catch (err) {
      // Một puuid hỏng không được làm chết cả lượt crawl — phần trận đấu đã lưu xong ở trên rồi.
      log(`[crawl] Không tra được tên cho 1 puuid: ${(err as Error).message}`);
    }
  }

  log(`[crawl] Đã tra thêm ${resolved} tên cho bảng xếp hạng (còn thiếu ${top.length - haveName.size - resolved}).`);
  return resolved;
}

export async function runCrawl(opts: RunCrawlOptions): Promise<RunCrawlResult> {
  const { apiKey, platform, tiers, queue = "RANKED_TFT", limit, matchesPerPlayer = 5 } = opts;
  const log = opts.onLog ?? console.log;

  const region = regionForPlatform(platform);
  const deadline = Date.now() + RUN_BUDGET_MS;
  const client = new RiotClient(apiKey);
  const db = opts.ensureSchema === false ? await getDb() : await getDbWithSchema();

  log(`[crawl] Lấy bảng xếp hạng ${tiers.join("+")} — platform=${platform} region=${region} queue=${queue}`);
  const ladders = await Promise.all(tiers.map((t) => client.getLeague(platform, t, queue)));
  // Gộp theo puuid. Một tài khoản chỉ ở đúng một hạng nên về lý thuyết nối mảng là đủ, nhưng
  // gộp bằng Map thì kể cả Riot có trả trùng cũng không sinh ra bản ghi lặp.
  const byPuuid = new Map<string, (typeof ladders)[number]["entries"][number]>();
  for (const l of ladders) for (const e of l.entries) byPuuid.set(e.puuid, e);
  const league = { entries: [...byPuuid.values()] };
  log(
    `[crawl] Tìm thấy ${league.entries.length} người chơi (${ladders
      .map((l, i) => `${tiers[i]}: ${l.entries.length}`)
      .join(", ")}).`,
  );

  const candidateMatchIds = new Set<string>();
  let scannedPlayers = 0;

  // XÁO TRỘN trước khi quét. Trước đây vòng lặp duyệt bảng xếp hạng theo đúng thứ tự rồi dừng
  // khi đủ `limit` id ứng viên, nên với cấu hình cron (limit=40, 5 trận/người) lượt nào cũng
  // chỉ đụng đúng ~8 người đầu bảng trong tổng số ~129 người. Đo thật ở một lượt cron: 41 id
  // ứng viên thì 20 đã có sẵn trong DB — gần một nửa số request là công cốc, và tỉ lệ trùng
  // chỉ càng tăng khi cron chạy dày, vì 8 tài khoản đó không thể sinh ra 40 trận mới mỗi giờ.
  //
  // Xáo trộn giữ nguyên chi phí request mỗi lượt nhưng mỗi lượt chạm một nhóm người chơi khác
  // nhau, nên thu về nhiều trận mới hơn và mẫu thống kê trải đều cả nhóm Challenger thay vì
  // dồn vào vài tài khoản.
  const players = shuffle(league.entries);

  for (const entry of players) {
    if (candidateMatchIds.size >= limit) break;
    scannedPlayers++;
    try {
      const ids = await client.getMatchIdsByPuuid(region, entry.puuid, matchesPerPlayer);
      for (const id of ids) candidateMatchIds.add(id);
    } catch (err) {
      log(`[crawl] Bỏ qua puuid lỗi: ${(err as Error).message}`);
    }
    if (scannedPlayers % 50 === 0) {
      log(`[crawl] Đã quét ${scannedPlayers} người chơi, thu thập ${candidateMatchIds.size} match id.`);
    }
  }

  log(`[crawl] Tổng cộng ${candidateMatchIds.size} match id ứng viên. Bắt đầu tải chi tiết trận đấu...`);

  // Bản đang chạy — đọc MỘT LẦN mỗi lượt, không đọc lại cho từng trận. Lỗi thì patchWindows
  // chỉ thiếu bản mới nhất, trận vẫn được lưu bình thường (game_patch có thể null).
  let patchWindows: Awaited<ReturnType<typeof syncPatchVersions>> = [];
  try {
    patchWindows = await syncPatchVersions(db);
  } catch (err) {
    log(`[crawl] Không ghi nhận được bản cập nhật: ${(err as Error).message}`);
  }

  let fetched = 0;
  let skippedExisting = 0;
  for (const matchId of candidateMatchIds) {
    if (fetched >= limit) break;
    // Hết giờ thì dừng hẳn. Số trận lấy được ít hơn một chút còn hơn để cả lượt bị tính là lỗi.
    if (Date.now() >= deadline) {
      log(`[crawl] Dừng tải trận vì hết ngân sách thời gian (đã lưu ${fetched}).`);
      break;
    }
    const existsRes = await db.execute({ sql: "SELECT 1 FROM matches WHERE match_id = ?", args: [matchId] });
    if (existsRes.rows.length > 0) {
      skippedExisting++;
      continue;
    }
    try {
      const match = (await client.getMatch(region, matchId)) as {
        info?: { queue_id?: number; game_version?: string; game_datetime?: number; tft_set_number?: number };
      };
      const info = match.info ?? {};
      await db.execute({
        sql: `INSERT OR IGNORE INTO matches (match_id, region, queue_id, game_version, game_datetime, raw_json, packed, fetched_at, patch, game_patch)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          matchId,
          region,
          info.queue_id ?? null,
          info.game_version ?? null,
          info.game_datetime ?? null,
          // raw_json để rỗng: nội dung thật nằm ở cột `packed`. Cột này còn NOT NULL từ
          // schema cũ nên không đặt NULL được, và ALTER TABLE của SQLite không gỡ được ràng buộc đó.
          "",
          packMatch(match),
          new Date().toISOString(),
          // Tính SẴN khoá phân vùng ngay lúc lưu. ETL dựa vào cột này để biết cohort nào có
          // trận mới mà không phải parse lại toàn bộ raw_json (xem addPatchColumnToMatchesIfNeeded).
          extractPatch(info.game_version ?? null, info.tft_set_number ?? null),
          // Bản đang chạy trên server của trận lúc trận diễn ra (vd "16.18") — xem livePatch.ts.
          patchAt(patchWindows, info.game_datetime ?? null, platformFromMatchId(matchId)),
        ],
      });
      fetched++;
      if (fetched % 100 === 0) log(`[crawl] Đã lưu ${fetched} trận...`);
    } catch (err) {
      log(`[crawl] Lỗi tải trận ${matchId}: ${(err as Error).message}`);
    }
  }

  log(`[crawl] Hoàn tất. Lưu mới ${fetched} trận, bỏ qua ${skippedExisting} trận đã có sẵn trong DB.`);

  const namesResolved = await backfillLeaderboardNames(db, client, platform, league.entries, log, deadline);

  return {
    platform,
    region,
    playersFound: league.entries.length,
    candidateMatchIds: candidateMatchIds.size,
    fetched,
    skippedExisting,
    namesResolved,
  };
}
