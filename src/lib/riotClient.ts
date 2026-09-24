// Client Riot API dùng chung cho crawler. Độc lập với Next.js.
//
// LƯU Ý VỀ ĐỘ CHÍNH XÁC: phần routing platform -> region bên dưới dựa trên
// tài liệu chính thức tại thời điểm viết. Trước khi crawl quy mô lớn, đối
// chiếu lại https://developer.riotgames.com/docs/tft (mục "Routing Values")
// vì Riot có thể điều chỉnh khi mở/gộp server.

export type Platform =
  | "na1" | "br1" | "la1" | "la2" | "oc1"
  | "kr" | "jp1"
  | "euw1" | "eun1" | "tr1" | "ru"
  | "vn2" | "sg2" | "th2" | "tw2" | "ph2";

export type Region = "americas" | "asia" | "europe" | "sea";

// TODO: xác thực lại oc1 — Riot đã chuyển một số server SEA (vn2/sg2/th2/tw2/ph2)
// sang routing "sea" khi vận hành trực tiếp (không qua Garena) từ 2023. oc1 có thể
// vẫn thuộc "americas" hoặc cũng đã chuyển; kiểm tra lại trước khi dùng platform này.
const PLATFORM_TO_REGION: Record<Platform, Region> = {
  na1: "americas", br1: "americas", la1: "americas", la2: "americas", oc1: "americas",
  kr: "asia", jp1: "asia",
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe",
  vn2: "sea", sg2: "sea", th2: "sea", tw2: "sea", ph2: "sea",
};

export function regionForPlatform(platform: Platform): Region {
  return PLATFORM_TO_REGION[platform];
}

/**
 * account-v1 (Riot Account API, dùng chung mọi game) KHÔNG hỗ trợ routing "sea" — ĐÃ TEST
 * THỰC TẾ (VN2, gọi qua tft.vn's match-history) trả về 403 khi dùng "sea", trong khi
 * "americas"/"asia"/"europe" đều trả 200 với CÙNG puuid (account-v1 được đồng bộ toàn cầu
 * qua 3 cluster đó, không phân biệt theo platform như match-v1/league-v1). Vì vậy account-v1
 * cho các platform SEA phải gọi qua "asia" thay vì "sea" — chỉ áp dụng cho account-v1, các
 * API khác (match-v1, league-v1) vẫn dùng regionForPlatform() bình thường.
 */
export function accountRegionForPlatform(platform: Platform): Region {
  const region = regionForPlatform(platform);
  return region === "sea" ? "asia" : region;
}

interface RateLimiterOptions {
  perSecond: number;
  /**
   * Hạn mức THEO PHƯƠNG THỨC, cửa sổ 10 giây.
   *
   * Đây là thứ trước đây bị bỏ sót. Header của Riot trả về HAI nhóm hạn mức:
   *   x-app-rate-limit    100:120,20:1    (ứng dụng: 100/2 phút, 20/giây)
   *   x-method-rate-limit 500:600,30:10   (phương thức: 500/10 phút, 30/10 giây)
   * Code chỉ canh nhóm đầu, nên khi tăng tốc lên 18 request/giây thì nhóm thứ hai vỡ ngay ở
   * giây thứ hai — đã dính 429 thật khi thử với 64 ứng viên.
   */
  per10Sec: number;
  per2Min: number;
}

/** Giới hạn tốc độ gọi API kiểu sliding-window, an toàn hơn hạn mức thật của Riot dev key (20/1s, 100/2min). */
class RateLimiter {
  private secondWindow: number[] = [];
  private tenSecWindow: number[] = [];
  private twoMinWindow: number[] = [];
  constructor(private opts: RateLimiterOptions) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.secondWindow = this.secondWindow.filter((t) => now - t < 1000);
      this.tenSecWindow = this.tenSecWindow.filter((t) => now - t < 10_000);
      this.twoMinWindow = this.twoMinWindow.filter((t) => now - t < 120_000);

      if (
        this.secondWindow.length < this.opts.perSecond &&
        this.tenSecWindow.length < this.opts.per10Sec &&
        this.twoMinWindow.length < this.opts.per2Min
      ) {
        this.secondWindow.push(now);
        this.tenSecWindow.push(now);
        this.twoMinWindow.push(now);
        return;
      }

      const waitFor1s = this.secondWindow.length >= this.opts.perSecond ? 1000 - (now - this.secondWindow[0]) : 0;
      const waitFor10s = this.tenSecWindow.length >= this.opts.per10Sec ? 10_000 - (now - this.tenSecWindow[0]) : 0;
      const waitFor2m = this.twoMinWindow.length >= this.opts.per2Min ? 120_000 - (now - this.twoMinWindow[0]) : 0;
      await sleep(Math.max(waitFor1s, waitFor10s, waitFor2m, 50));
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mang theo status HTTP để caller phân biệt 404 (không tìm thấy) với lỗi thật khác. */
export class RiotApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RiotApiError";
  }
}

export class RiotClient {
  /**
   * MỘT bộ giới hạn cho MỖI HOST, không phải một bộ dùng chung.
   *
   * Riot tính hạn mức RIÊNG cho từng routing value — đã đo bằng header x-app-rate-limit-count:
   * gọi vn2 ba lần thì bộ đếm của vn2 lên 3 trong khi kr, na1, euw1 và cả 4 cụm vùng
   * (sea/asia/americas/europe) vẫn bằng 1. Gộp tất cả vào một bộ đếm chung khiến ta tự phanh
   * sớm hơn nhiều so với giới hạn thật: một lượt crawl chạm tới 3 host khác nhau (platform cho
   * bảng xếp hạng, cụm vùng cho trận, cụm account cho tên) nên bộ đếm chung tưởng đã dùng 84
   * request trong khi host bận nhất mới chỉ dùng 42.
   */
  private limiters = new Map<string, RateLimiter>();
  private limiterOptions: RateLimiterOptions;
  private apiKey: string;

  constructor(apiKey: string, opts?: Partial<RateLimiterOptions>) {
    if (!apiKey) throw new Error("Thiếu RIOT_API_KEY");
    this.apiKey = apiKey;
    // Mặc định để dư an toàn dưới hạn mức 20/1s và 100/2min mà key khai báo trong header.
    this.limiterOptions = {
      perSecond: opts?.perSecond ?? 18,
      // 28 chứ không phải 30: chừa chỗ cho sai lệch đồng hồ giữa máy này và máy Riot, vì cửa sổ
      // của ta bắt đầu tính từ lúc GỬI còn của họ từ lúc NHẬN.
      per10Sec: opts?.per10Sec ?? 28,
      per2Min: opts?.per2Min ?? 95,
    };
  }

  /** Bộ giới hạn của host này, tạo khi lần đầu gọi tới nó. */
  private limiterFor(url: string): RateLimiter {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      // URL hỏng thì dồn hết vào một bộ chung — thà phanh thừa còn hơn bỏ qua giới hạn.
      host = "unknown";
    }
    let limiter = this.limiters.get(host);
    if (!limiter) {
      limiter = new RateLimiter(this.limiterOptions);
      this.limiters.set(host, limiter);
    }
    return limiter;
  }

  private async request<T>(url: string, retriesLeft = 5): Promise<T> {
    await this.limiterFor(url).acquire();
    const res = await fetch(url, { headers: { "X-Riot-Token": this.apiKey } });

    if (res.status === 429) {
      if (retriesLeft <= 0) throw new Error(`Rate limited liên tục, bỏ cuộc: ${url}`);
      const retryAfter = Number(res.headers.get("retry-after")) || 2;
      console.warn(`[riot] Rate limited; retrying in ${retryAfter}s`);
      await sleep(retryAfter * 1000 + 250);
      return this.request<T>(url, retriesLeft - 1);
    }

    if (res.status >= 500) {
      if (retriesLeft <= 0) throw new Error(`Lỗi server Riot liên tục: ${url}`);
      await sleep(1500);
      return this.request<T>(url, retriesLeft - 1);
    }

    if (!res.ok) {
      throw new RiotApiError(res.status, `Riot API ${res.status} ${res.statusText} — ${url}`);
    }

    return res.json() as Promise<T>;
  }

  /** GM/Challenger/Master league entries. queue mặc định RANKED_TFT. */
  async getLeague(platform: Platform, tier: "challenger" | "grandmaster" | "master", queue = "RANKED_TFT") {
    const url = `https://${platform}.api.riotgames.com/tft/league/v1/${tier}?queue=${queue}`;
    return this.request<{
      leagueId: string;
      tier: string;
      name: string;
      queue: string;
      entries: Array<{ puuid: string; leaguePoints: number; wins: number; losses: number; rank: string }>;
    }>(url);
  }

  async getMatchIdsByPuuid(region: Region, puuid: string, count = 5) {
    const url = `https://${region}.api.riotgames.com/tft/match/v1/matches/by-puuid/${puuid}/ids?count=${count}`;
    return this.request<string[]>(url);
  }

  async getMatch(region: Region, matchId: string) {
    return this.request<unknown>(`https://${region}.api.riotgames.com/tft/match/v1/matches/${matchId}`);
  }

  /** account-v1 dùng regional routing (americas/asia/europe/sea), không phải platform. */
  async getAccountByRiotId(region: Region, gameName: string, tagLine: string) {
    const url = `https://${region}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    return this.request<{ puuid: string; gameName: string; tagLine: string }>(url);
  }

  /**
   * Riot ID (gameName#tagLine) theo puuid — chiều ngược lại của getAccountByRiotId.
   *
   * Cần vì league-v1 CHỈ trả về puuid, không trả tên. Bảng xếp hạng vì thế chỉ hiện được tên
   * của những người tình cờ đã có trong known_players nhờ crawl trận; phần còn lại trống trơn.
   *
   * Dùng regional routing giống getAccountByRiotId — với platform SEA phải đi qua "asia",
   * xem ghi chú ở accountRegionForPlatform.
   */
  async getAccountByPuuid(region: Region, puuid: string) {
    const url = `https://${region}.api.riotgames.com/riot/account/v1/accounts/by-puuid/${puuid}`;
    return this.request<{ puuid: string; gameName: string; tagLine: string }>(url);
  }

  /**
   * Rank HIỆN TẠI theo puuid (tại thời điểm gọi API, không phải rank lúc chơi trận đã crawl
   * nếu trận đó cũ) — ĐÃ XÁC THỰC path đúng bằng cách gọi thật với 1 puuid có sẵn trong
   * known_players (platform vn2), phản hồi 200 kèm đủ field kỳ vọng, vd:
   *   { queueType: "RANKED_TFT", tier: "CHALLENGER", rank: "I", leaguePoints: 1625,
   *     wins: 252, losses: 126, puuid, veteran, inactive, freshBlood, hotStreak }
   * (4 field cuối không có trong type khai báo trước đây, đã bổ sung khớp response thật).
   * CHƯA có nơi nào gọi hàm này — quyết định hoãn triển khai lọc theo rank cho tới khi khối
   * lượng dữ liệu crawl qua cron tăng đáng kể, xem đánh giá chi phí request trong lịch sử trao
   * đổi (ước tính ~68 phút backfill 1 lần cho ~3200 puuid đã biết ở thời điểm đánh giá).
   */
  async getLeagueEntriesByPuuid(platform: Platform, puuid: string) {
    const url = `https://${platform}.api.riotgames.com/tft/league/v1/by-puuid/${puuid}`;
    return this.request<
      Array<{
        puuid: string;
        queueType: string;
        tier: string;
        rank: string;
        leaguePoints: number;
        wins: number;
        losses: number;
        veteran: boolean;
        inactive: boolean;
        freshBlood: boolean;
        hotStreak: boolean;
      }>
    >(url);
  }
}
