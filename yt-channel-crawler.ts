// yt-channel-crawler.ts
// --------------------------------------------------
// Load .env (supports YT_API_KEYS="keyA,keyB" or YT_API_KEY="keyA,keyB")
// --------------------------------------------------
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { google, youtube_v3 } from "googleapis";
import { createObjectCsvWriter as csvWriter } from "csv-writer";
import { exec } from "node:child_process";
import { promisify } from "node:util";
const pexec = promisify(exec);

// --------------------------------------------------
// 설정(쿼터 절약 & 로테이션)
// --------------------------------------------------
const USE_VIDEO_RANK = false; // Step2(영상 기반 보강) 기본 OFF → 쿼터 절약
const MAX_VIDEO_SEARCH_PAGES = 1; // Step2 켤 때 1~2 권장
const DEFAULT_LIMIT = 30; // 기본 채널 수
const DEFAULT_DAYS = 7; // 기본 기간(일)
const ROTATION_MODE: "on_error" | "round_robin" = "on_error"; // 키 로테이션 모드

// NEW: 키워드 Top 동영상 옵션
const MAX_VIDEOS_PER_CHANNEL = Number(process.argv[5] || 3); // 채널별 Top K
const INCLUDE_SHORTS: "both" | "shorts" | "long" = ((process.argv[6] as any) ||
  "both") as any; // 쇼츠 필터
const TOP_VIDEOS_LIMIT = Number(process.argv[7] || 100); // 글로벌 Top 동영상 개수
const VIDEOS_DAYS = Number(process.argv[8] || 7); // 키워드 동영상 집계 기간
const VIDEO_SEARCH_PAGES = Number(process.argv[9] || 3); // 검색 페이지 수

// --------------------------------------------------
// API 키 로테이터
// --------------------------------------------------
function loadApiKeys(): string[] {
  const list1 = (process.env.YT_API_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list1.length) return list1;

  const list2 = (process.env.YT_API_KEY || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list2;
}
const API_KEYS = loadApiKeys();
if (!API_KEYS.length) {
  throw new Error(
    "환경변수 YT_API_KEY 또는 YT_API_KEYS에 API 키를 콤마로 넣어주세요."
  );
}

let currentKeyIndex = 0;
const makeClient = (key: string) =>
  google.youtube({ version: "v3", auth: key });
let yt = makeClient(API_KEYS[currentKeyIndex]);

function rotateOnError() {
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  yt = makeClient(API_KEYS[currentKeyIndex]);
}
function rotateRoundRobin() {
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  yt = makeClient(API_KEYS[currentKeyIndex]);
}

// 모든 YouTube 호출을 감싸 키 자동 교체
async function withYt<T>(
  call: (client: youtube_v3.Youtube) => Promise<T>
): Promise<T> {
  const attempts = API_KEYS.length;

  // 매 호출 분산 모드
  if (ROTATION_MODE === "round_robin" && API_KEYS.length > 1) {
    rotateRoundRobin();
  }

  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await call(yt);
    } catch (e: any) {
      const reason =
        e?.errors?.[0]?.reason ||
        e?.response?.data?.error?.errors?.[0]?.reason ||
        e?.message ||
        "";
      const isQuota =
        String(reason).toLowerCase().includes("quota") || e?.code === 403;

      lastErr = e;
      if (ROTATION_MODE === "on_error" && isQuota && API_KEYS.length > 1) {
        rotateOnError();
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("모든 API 키가 실패했습니다.");
}

// --------------------------------------------------
// 캐싱 (.ytcache.json)
// --------------------------------------------------
const CACHE_PATH = "./.ytcache.json";
type Cache = {
  search: Record<string, { ts: number; ids: string[] }>;
  channels: Record<string, { ts: number; data: any }>;
  stats: Record<string, { ts: number; data: any }>;
};
const cache: Cache = existsSync(CACHE_PATH)
  ? JSON.parse(readFileSync(CACHE_PATH, "utf8"))
  : { search: {}, channels: {}, stats: {} };

const saveCache = () =>
  writeFileSync(CACHE_PATH, JSON.stringify(cache), "utf8");
const now = () => Date.now();
const within = (ts: number, ms: number) => now() - ts < ms;
const TTL_SEARCH = 24 * 60 * 60 * 1000; // 24h
const TTL_CHANNELS = 24 * 60 * 60 * 1000; // 24h
const TTL_STATS = 3 * 60 * 60 * 1000; // 3h

// --------------------------------------------------
// 유틸
// --------------------------------------------------
async function openFile(filePath: string) {
  const plat = process.platform;
  if (plat === "darwin") await pexec(`open "${filePath}"`);
  else if (plat === "win32")
    await pexec(`start "" "${filePath}"`, { shell: "cmd.exe" });
  else await pexec(`xdg-open "${filePath}"`);
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const oscLink = (label: string, url: string) =>
  `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;

// ISO8601 duration → seconds
function parseISODurationToSeconds(iso?: string): number {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  return h * 3600 + min * 60 + s;
}
function isShortBySeconds(sec: number): boolean {
  return sec > 0 && sec < 60;
}
function shortFilterPass(sec: number): boolean {
  if (INCLUDE_SHORTS === "both") return true;
  const short = isShortBySeconds(sec);
  return INCLUDE_SHORTS === "shorts" ? short : !short;
}
function normTitle(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

// ---- 날짜/시계열 유틸 & 그래프(SVG) ----
function yyyymmddUTC(d: Date) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function makeLastNDaysKeys(n: number) {
  const days: string[] = [];
  const end = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(end.getTime() - i * 86400_000);
    days.push(yyyymmddUTC(dt));
  }
  return days;
}
type DaySeries = { day: string; count: number; views: number };
function buildDailySeries(
  videos: { publishedAt: string; views: number }[],
  days: number
): DaySeries[] {
  const keys = makeLastNDaysKeys(days);
  const map = new Map<string, { count: number; views: number }>();
  keys.forEach((k) => map.set(k, { count: 0, views: 0 }));

  for (const v of videos) {
    if (!v.publishedAt) continue;
    const day = yyyymmddUTC(new Date(v.publishedAt));
    if (!map.has(day)) continue;
    const cur = map.get(day)!;
    cur.count += 1;
    cur.views += Number(v.views || 0);
  }
  return keys.map((k) => ({
    day: k,
    count: map.get(k)!.count,
    views: map.get(k)!.views,
  }));
}
function makeLinePath(values: number[], w: number, h: number, pad = 8) {
  const max = Math.max(1, ...values);
  const n = values.length;
  const xStep = (w - pad * 2) / Math.max(1, n - 1);
  const toX = (i: number) => pad + i * xStep;
  const toY = (v: number) => h - pad - (v / max) * (h - pad * 2);

  let d = "";
  values.forEach((v, i) => {
    const x = toX(i);
    const y = toY(v);
    d += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
  });
  return d;
}
function renderMiniLineSVG(
  values: number[],
  width = 720,
  height = 160,
  label = ""
) {
  const path = makeLinePath(values, width, height);
  const max = Math.max(1, ...values);
  const last = values[values.length - 1] ?? 0;
  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>
  <path d="${path}" fill="none" stroke="#2563eb" stroke-width="2"/>
  <text x="${
    width - 8
  }" y="16" text-anchor="end" font-size="12" fill="#6b7280">max ${max.toLocaleString()}</text>
  <text x="${width - 8}" y="${
    height - 8
  }" text-anchor="end" font-size="12" fill="#6b7280">last ${last.toLocaleString()}</text>
</svg>`;
}

// --------------------------------------------------
// 1) 채널 검색(하이브리드, 캐시)
// --------------------------------------------------
async function searchChannelsByKeyword(
  keyword: string,
  maxChannels: number,
  regionCode = "KR",
  relevanceLanguage = "ko"
) {
  const skey = `kw=${keyword}|rc=${regionCode}|rl=${relevanceLanguage}|limit=${maxChannels}|rank=${USE_VIDEO_RANK}`;
  const hit = cache.search[skey];
  if (hit && within(hit.ts, TTL_SEARCH) && hit.ids.length >= maxChannels) {
    return hit.ids.slice(0, maxChannels);
  }

  const channelIds = new Set<string>();
  let pageToken: string | undefined;

  // Step 1: 채널 검색
  while (channelIds.size < maxChannels) {
    const r = await withYt((yt) =>
      yt.search.list({
        part: ["snippet"],
        q: keyword,
        type: ["channel"],
        maxResults: 50,
        pageToken,
        regionCode,
        relevanceLanguage,
        order: "relevance",
        safeSearch: "none",
      } as youtube_v3.Params$Resource$Search$List)
    );
    r.data.items?.forEach(
      (i) => i.id?.channelId && channelIds.add(i.id.channelId)
    );
    pageToken = r.data.nextPageToken || undefined;
    if (!pageToken) break;
    await sleep(60);
  }

  // Step 2(옵션): 동영상 기반 보강
  if (USE_VIDEO_RANK && channelIds.size < maxChannels) {
    const score = new Map<string, number>();
    pageToken = undefined;
    let pageCount = 0;

    while (pageCount < MAX_VIDEO_SEARCH_PAGES && score.size < maxChannels) {
      const r = await withYt((yt) =>
        yt.search.list({
          part: ["snippet"],
          q: keyword,
          type: ["video"],
          maxResults: 50,
          pageToken,
          regionCode,
          relevanceLanguage,
          order: "viewCount",
          safeSearch: "none",
        } as youtube_v3.Params$Resource$Search$List)
      );
      const vidIds =
        (r.data.items?.map((v) => v.id?.videoId).filter(Boolean) as string[]) ||
        [];

      for (let i = 0; i < vidIds.length; i += 50) {
        const vr = await withYt((yt) =>
          yt.videos.list({
            id: vidIds.slice(i, i + 50),
            part: ["statistics", "snippet"],
            maxResults: 50,
          } as youtube_v3.Params$Resource$Videos$List)
        );
        vr.data.items?.forEach((v) => {
          const chId = v.snippet?.channelId;
          const views = Number(v.statistics?.viewCount || 0);
          if (!chId) return;
          score.set(chId, Math.max(score.get(chId) ?? 0, views));
        });
        await sleep(50);
      }

      pageToken = r.data.nextPageToken || undefined;
      pageCount++;
      if (!pageToken) break;
      await sleep(60);
    }

    const ranked = [...score.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ch]) => ch);
    for (const ch of ranked) {
      if (channelIds.size >= maxChannels) break;
      channelIds.add(ch);
    }
  }

  // Step 3: 여전히 부족하면 지역/언어 해제
  if (channelIds.size < maxChannels) {
    pageToken = undefined;
    while (channelIds.size < maxChannels) {
      const r = await withYt((yt) =>
        yt.search.list({
          part: ["snippet"],
          q: keyword,
          type: ["channel"],
          maxResults: 50,
          pageToken,
          order: "relevance",
          safeSearch: "none",
        } as youtube_v3.Params$Resource$Search$List)
      );
      r.data.items?.forEach(
        (i) => i.id?.channelId && channelIds.add(i.id.channelId)
      );
      pageToken = r.data.nextPageToken || undefined;
      if (!pageToken) break;
      await sleep(60);
    }
  }

  const ids = Array.from(channelIds).slice(0, maxChannels);
  cache.search[skey] = { ts: now(), ids };
  saveCache();
  return ids;
}

// --------------------------------------------------
// 2) 채널 메타데이터(캐시)
// --------------------------------------------------
async function getChannelMeta(ids: string[]) {
  const results: {
    id: string;
    title: string;
    country?: string;
    subs: number;
    viewCount: number;
    uploadsPlaylistId: string;
    customUrlPath?: string;
  }[] = [];

  const fresh = (id: string) => {
    const h = cache.channels[id];
    return h && within(h.ts, TTL_CHANNELS);
  };
  const fromCache: Record<string, any> = {};
  ids.forEach((id) => {
    if (fresh(id)) fromCache[id] = cache.channels[id].data;
  });
  const todo = ids.filter((id) => !fromCache[id]);

  for (let i = 0; i < todo.length; i += 50) {
    const r = await withYt((yt) =>
      yt.channels.list({
        id: todo.slice(i, i + 50),
        part: ["snippet", "statistics", "contentDetails"],
        maxResults: 50,
      } as youtube_v3.Params$Resource$Channels$List)
    );
    r.data.items?.forEach((ch) => {
      const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads || !ch.id) return;
      const obj = {
        id: ch.id,
        title: ch.snippet?.title || "(no title)",
        country: ch.snippet?.country || undefined,
        subs: Number(ch.statistics?.subscriberCount || 0),
        viewCount: Number(ch.statistics?.viewCount || 0),
        uploadsPlaylistId: uploads,
        customUrlPath: ch.snippet?.customUrl || undefined,
      };
      cache.channels[ch.id] = { ts: now(), data: obj };
      fromCache[ch.id] = obj;
    });
    await sleep(60);
  }
  saveCache();

  ids.forEach((id) => {
    if (fromCache[id]) results.push(fromCache[id]);
  });
  return results;
}

// --------------------------------------------------
// 3) 최근 N일 통계(캐시 + 조기종료 + 쇼츠필터 + 채널별 TopK)
// --------------------------------------------------
async function getRecentVideosStats(
  uploadsPlaylistId: string,
  days = DEFAULT_DAYS
) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const statKey = `${uploadsPlaylistId}|d=${days}|sf=${INCLUDE_SHORTS}`;
  const sHit = cache.stats[statKey];
  if (sHit && within(sHit.ts, TTL_STATS)) return sHit.data;

  const videoIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const r = await withYt((yt) =>
      yt.playlistItems.list({
        playlistId: uploadsPlaylistId,
        part: ["contentDetails"],
        maxResults: 50,
        pageToken,
      } as youtube_v3.Params$Resource$Playlistitems$List)
    );

    const items = r.data.items || [];
    items.forEach((it) => {
      const vid = it.contentDetails?.videoId;
      const at = it.contentDetails?.videoPublishedAt;
      if (vid && at && new Date(at) >= since) videoIds.push(vid);
    });

    const allOld =
      items.length > 0 &&
      items.every((it) => {
        const at = it.contentDetails?.videoPublishedAt;
        return !at || new Date(at) < since;
      });
    if (allOld) {
      pageToken = undefined;
      break;
    }

    pageToken = r.data.nextPageToken || undefined;
    await sleep(50);
  } while (pageToken);

  if (!videoIds.length) {
    const empty = {
      videos: [] as {
        id: string;
        title: string;
        views: number;
        publishedAt: string;
        durationSec: number;
      }[],
      sumViews7d: 0,
      avgViews7d: 0,
      uploads7d: 0,
      uploads24h: 0,
      topK: [] as any[],
    };
    cache.stats[statKey] = { ts: now(), data: empty };
    saveCache();
    return empty;
  }

  const videos: {
    id: string;
    title: string;
    views: number;
    publishedAt: string;
    durationSec: number;
  }[] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const r = await withYt((yt) =>
      yt.videos.list({
        id: videoIds.slice(i, i + 50),
        part: ["snippet", "statistics", "contentDetails"],
        maxResults: 50,
      } as youtube_v3.Params$Resource$Videos$List)
    );
    r.data.items?.forEach((v) => {
      const publishedAt = v.snippet?.publishedAt || "";
      const durationSec = parseISODurationToSeconds(v.contentDetails?.duration);
      if (!shortFilterPass(durationSec)) return;

      videos.push({
        id: v.id!,
        title: v.snippet?.title || "(no title)",
        views: Number(v.statistics?.viewCount || 0),
        publishedAt,
        durationSec,
      });
    });
    await sleep(50);
  }

  const sumViews7d = videos.reduce((s, v) => s + v.views, 0);
  const avgViews7d = videos.length ? Math.round(sumViews7d / videos.length) : 0;
  const uploads24h = videos.filter(
    (v) => new Date(v.publishedAt) >= new Date(Date.now() - 24 * 60 * 60 * 1000)
  ).length;

  const topK = [...videos]
    .sort((a, b) => b.views - a.views)
    .slice(0, MAX_VIDEOS_PER_CHANNEL);

  const result = {
    videos,
    sumViews7d,
    avgViews7d,
    uploads7d: videos.length,
    uploads24h,
    topK,
  };
  cache.stats[statKey] = { ts: now(), data: result };
  saveCache();
  return result;
}

// --------------------------------------------------
// 4) 키워드로 최근 N일 Top 동영상 수집(검색 기반 보드)
// --------------------------------------------------
async function getTopVideosByKeyword(
  keyword: string,
  days = VIDEOS_DAYS,
  regionCode = "KR",
  relevanceLanguage = "ko",
  maxPages = VIDEO_SEARCH_PAGES
) {
  const sinceISO = new Date(Date.now() - days * 86400_000).toISOString();

  const foundVideoIds: string[] = [];
  let pageToken: string | undefined;
  let page = 0;

  while (page < maxPages) {
    const r = await withYt((yt) =>
      yt.search.list({
        part: ["snippet"],
        q: keyword,
        type: ["video"],
        maxResults: 50,
        pageToken,
        regionCode,
        relevanceLanguage,
        publishedAfter: sinceISO,
        order: "viewCount",
        safeSearch: "none",
      } as youtube_v3.Params$Resource$Search$List)
    );
    r.data.items?.forEach(
      (it) => it.id?.videoId && foundVideoIds.push(it.id.videoId)
    );
    pageToken = r.data.nextPageToken || undefined;
    page++;
    if (!pageToken) break;
    await sleep(60);
  }

  type V = {
    video_id: string;
    title: string;
    views: number;
    publishedAt: string;
    durationSec: number;
    channel_id: string;
    channel_title: string;
    channel_url: string;
    watch_url: string;
  };
  const videos: V[] = [];
  const seen = new Set<string>();
  const seenTitle = new Set<string>();

  for (let i = 0; i < foundVideoIds.length; i += 50) {
    const ids = foundVideoIds.slice(i, i + 50);
    const vr = await withYt((yt) =>
      yt.videos.list({
        id: ids,
        part: ["snippet", "statistics", "contentDetails"],
        maxResults: 50,
      } as youtube_v3.Params$Resource$Videos$List)
    );

    vr.data.items?.forEach((v) => {
      const id = v.id!;
      if (!id || seen.has(id)) return;

      const title = v.snippet?.title || "(no title)";
      const publishedAt = v.snippet?.publishedAt || "";
      const durationSec = parseISODurationToSeconds(v.contentDetails?.duration);
      if (!shortFilterPass(durationSec)) return;

      const keyTitle = normTitle(title);
      if (seenTitle.has(keyTitle)) return;

      const views = Number(v.statistics?.viewCount || 0);
      const chId = v.snippet?.channelId || "";
      const chTitle = v.snippet?.channelTitle || "";
      const channel_url = chId ? `https://www.youtube.com/channel/${chId}` : "";
      const watch_url = `https://www.youtube.com/watch?v=${id}`;

      videos.push({
        video_id: id,
        title,
        views,
        publishedAt,
        durationSec,
        channel_id: chId,
        channel_title: chTitle,
        channel_url,
        watch_url,
      });

      seen.add(id);
      seenTitle.add(keyTitle);
    });
    await sleep(50);
  }

  videos.sort((a, b) => b.views - a.views);
  return videos;
}

// --------------------------------------------------
// 5) Main: 진행 출력 + CSV/HTML 자동열기
// --------------------------------------------------
async function main() {
  const keyword = process.argv[2] || "정치";
  const limit = Number(process.argv[3] || DEFAULT_LIMIT);
  const days = Number(process.argv[4] || DEFAULT_DAYS);

  console.log(
    `🔎 Keyword="${keyword}", channels=${limit}, ch-days=${days}, videos-days=${VIDEOS_DAYS}, pages=${VIDEO_SEARCH_PAGES}, shorts=${INCLUDE_SHORTS}, topK=${MAX_VIDEOS_PER_CHANNEL}\n`
  );

  // 1) 키워드 관련 Top 동영상 보드
  const videosBoard = await getTopVideosByKeyword(
    keyword,
    VIDEOS_DAYS,
    "KR",
    "ko",
    VIDEO_SEARCH_PAGES
  );

  if (videosBoard.length) {
    const tsV = Date.now();
    const vCsv = `./yt_${keyword}_${tsV}_videos.csv`;
    const vWriter = csvWriter({
      path: vCsv,
      header: Object.keys(videosBoard[0]).map((k) => ({ id: k, title: k })),
    });
    await vWriter.writeRecords(videosBoard);
    console.log(`✅ Videos CSV saved: ${vCsv}`);
    await openFile(vCsv);

    // --- 그래프용 시계열 만들기 ---
    const daily = buildDailySeries(
      videosBoard.map((v) => ({ publishedAt: v.publishedAt, views: v.views })),
      VIDEOS_DAYS
    );
    const counts = daily.map((d) => d.count);
    const views = daily.map((d) => d.views);
    const svgCounts = renderMiniLineSVG(counts, 720, 160, "일자별 업로드 수");
    const svgViews = renderMiniLineSVG(views, 720, 160, "일자별 조회수 합계");

    const escapeHtml = (s: string) =>
      s.replace(
        /[&<>"']/g,
        (m) =>
          ((
            {
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            } as any
          )[m])
      );
    const vHtml = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/>
<title>Top Videos for ${escapeHtml(keyword)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
body{font-family:ui-sans-serif,system-ui;line-height:1.5;padding:24px}
h1{margin:0 0 8px;font-size:20px}
h2{margin:24px 0 8px;font-size:16px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #e5e7eb;padding:8px 10px;font-size:14px}
th{background:#f9fafb;text-align:left}
td.num{text-align:right}
a{color:#2563eb;text-decoration:none}
a:hover{text-decoration:underline}
.muted{color:#6b7280}
.grid{display:grid;grid-template-columns:1fr;gap:12px;margin:12px 0 24px}
.small{color:#6b7280;font-size:12px}
</style>
</head><body>
<h1>“${escapeHtml(keyword)}” 키워드 Top 동영상 · ${
      videosBoard.length
    }개 · ${VIDEOS_DAYS}일 · shorts=${escapeHtml(INCLUDE_SHORTS)}</h1>

<h2>관심도 프록시 그래프(최근 ${VIDEOS_DAYS}일)</h2>
<div class="grid">
  <div>
    <div class="small">일자별 업로드 수(관련 동영상 게시 수)</div>
    ${svgCounts}
  </div>
  <div>
    <div class="small">일자별 조회수 합계(관련 동영상의 누적 조회수 합계)</div>
    ${svgViews}
  </div>
  <div class="small">
    * YouTube API는 검색량 지표를 제공하지 않음 → 해당 키워드로 수집된 동영상의 <b>게시 수</b>와 <b>조회수 합계</b>를 관심도의 근사치로 사용.
  </div>
</div>

<table>
<thead><tr><th>#</th><th>제목</th><th>조회수</th><th>게시일</th><th>길이(초)</th><th>채널</th><th>시청</th></tr></thead>
<tbody>
${videosBoard
  .slice(0, TOP_VIDEOS_LIMIT)
  .map(
    (v: any, i: number) => `
<tr>
  <td class="num">${i + 1}</td>
  <td>${escapeHtml(v.title)}</td>
  <td class="num">${Number(v.views).toLocaleString()}</td>
  <td>${escapeHtml(v.publishedAt)}</td>
  <td class="num">${v.durationSec}</td>
  <td><a href="${v.channel_url}" target="_blank" rel="noopener">${escapeHtml(
      v.channel_title
    )}</a></td>
  <td><a href="${v.watch_url}" target="_blank" rel="noopener">Open</a></td>
</tr>`
  )
  .join("")}
</tbody>
</table>
</body></html>`;
    const vHtmlPath = `./yt_${keyword}_${tsV}_videos.html`;
    writeFileSync(vHtmlPath, vHtml, "utf8");
    console.log(`📄 Videos HTML saved: ${vHtmlPath}`);
    await openFile(vHtmlPath);
  } else {
    console.log("No videos found for the given filters/time window.");
  }

  // 2) 기존 채널 보드(채널별 최근 N일 집계 + 베스트 영상)
  const channelIds = await searchChannelsByKeyword(keyword, limit, "KR", "ko");
  const metas = await getChannelMeta(channelIds);

  const rows: any[] = [];
  const globalVideos: {
    video_id: string;
    title: string;
    views: number;
    publishedAt: string;
    durationSec: number;
    channel_id: string;
    channel_title: string;
    channel_url: string;
    watch_url: string;
  }[] = [];

  for (const ch of metas) {
    const recent = await getRecentVideosStats(ch.uploadsPlaylistId, days);

    for (const v of recent.videos) {
      globalVideos.push({
        video_id: v.id,
        title: v.title,
        views: v.views,
        publishedAt: v.publishedAt,
        durationSec: v.durationSec,
        channel_id: ch.id,
        channel_title: ch.title,
        channel_url: `https://www.youtube.com/channel/${ch.id}`,
        watch_url: `https://www.youtube.com/watch?v=${v.id}`,
      });
    }

    const best = recent.topK?.[0];

    const preferredUrl = ch.customUrlPath
      ? `https://www.youtube.com/${String(ch.customUrlPath).replace(
          /^\/+/,
          ""
        )}`
      : `https://www.youtube.com/channel/${ch.id}`;

    const row = {
      channel_id: ch.id,
      channel_title: ch.title,
      channel_url: `https://www.youtube.com/channel/${ch.id}`,
      channel_preferred_url: preferredUrl,
      country: ch.country || "",
      subscribers: ch.subs,
      lifetime_views: ch.viewCount,
      uploads_7d: recent.uploads7d,
      uploads_24h: recent.uploads24h,
      sum_views_7d: recent.sumViews7d,
      avg_views_per_video_7d: recent.avgViews7d,
      best_video_title_7d: best ? best.title : "",
      best_video_views_7d: best ? best.views : 0,
      best_video_url_7d: best
        ? `https://www.youtube.com/watch?v=${best.id}`
        : "",
    };
    rows.push(row);

    const idx = String(rows.length).padStart(3, "0");
    const link = oscLink("Open", preferredUrl);
    console.log(
      `${idx}. ${
        row.channel_title
      }  •  7d=${row.sum_views_7d.toLocaleString()}  •  ${link}  •  ${preferredUrl}`
    );

    await sleep(30);
  }

  if (!rows.length) {
    console.log("No channels found. Try widening keyword or limit.");
    return;
  }

  rows.sort((a, b) => b.sum_views_7d - a.sum_views_7d);
  const N = Math.min(50, rows.length);
  console.log(`\nTop ${N} channels (clickable):\n`);
  rows.slice(0, N).forEach((r: any, i: number) => {
    const idx = String(i + 1).padStart(2, "0");
    const url = r.channel_preferred_url || r.channel_url;
    console.log(
      `${idx}. ${
        r.channel_title
      }  •  7d=${r.sum_views_7d.toLocaleString()}  •  ${oscLink(
        "Open",
        url
      )}  •  ${url}`
    );
  });
  console.log("");

  const ts = Date.now();
  const csvPath = `./yt_${keyword}_${ts}_channels.csv`;
  const writer = csvWriter({
    path: csvPath,
    header: Object.keys(rows[0]).map((k) => ({ id: k, title: k })),
  });
  await writer.writeRecords(rows);
  console.log(`✅ Channels CSV saved: ${csvPath}`);
  await openFile(csvPath);

  const escapeHtml = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (m) =>
        ((
          {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          } as any
        )[m])
    );
  const channelsHtml = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/>
<title>YT Channels: ${escapeHtml(keyword)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{font-family:ui-sans-serif,system-ui;line-height:1.5;padding:24px}
  h1{margin:0 0 16px;font-size:20px}
  table{border-collapse:collapse;width:100%}
  th,td{border:1px solid #e5e7eb;padding:8px 10px;font-size:14px}
  th{background:#f9fafb;text-align:left}
  td.num{text-align:right}
  a{color:#2563eb;text-decoration:none}
  a:hover{text-decoration:underline}
  .muted{color:#6b7280}
</style>
</head><body>
<h1>Channels for "${escapeHtml(keyword)}" · ${
    rows.length
  }개 · ${days}일 · shorts=${escapeHtml(INCLUDE_SHORTS)}</h1>
<table>
  <thead>
    <tr>
      <th>#</th><th>Channel</th><th>7d Views</th><th>Uploads(7d)</th><th>Subs</th><th>Best Video</th><th>Link</th>
    </tr>
  </thead>
  <tbody>
    ${rows
      .map(
        (r: any, i: number) => `
      <tr>
        <td class="num">${i + 1}</td>
        <td>${escapeHtml(r.channel_title)}</td>
        <td class="num">${Number(r.sum_views_7d).toLocaleString()}</td>
        <td class="num">${r.uploads_7d}</td>
        <td class="num">${Number(r.subscribers).toLocaleString()}</td>
        <td>${
          r.best_video_url_7d
            ? `<a href="${
                r.best_video_url_7d
              }" target="_blank" rel="noopener">${escapeHtml(
                r.best_video_title_7d
              )}</a> <span class="muted">(${Number(
                r.best_video_views_7d
              ).toLocaleString()})</span>`
            : "-"
        }</td>
        <td><a href="${
          r.channel_preferred_url || r.channel_url
        }" target="_blank" rel="noopener">Open</a></td>
      </tr>
    `
      )
      .join("")}
  </tbody>
</table>
</body></html>`;
  const channelsHtmlPath = `./yt_${keyword}_${ts}_channels.html`;
  writeFileSync(channelsHtmlPath, channelsHtml, "utf8");
  console.log(`📄 Channels HTML saved: ${channelsHtmlPath}`);
  await openFile(channelsHtmlPath);

  // (선택) 채널 집계에서 모인 글로벌 영상 보드도 저장
  globalVideos.sort((a, b) => b.views - a.views);
  const topVideos = globalVideos.slice(0, TOP_VIDEOS_LIMIT);
  if (topVideos.length) {
    const vCsvPath = `./yt_${keyword}_${ts}_videos_from_channels.csv`;
    const vHeader = Object.keys(topVideos[0]).map((k) => ({ id: k, title: k }));
    const vWriter2 = csvWriter({ path: vCsvPath, header: vHeader });
    await vWriter2.writeRecords(topVideos);
    console.log(`✅ Videos-from-channels CSV saved: ${vCsvPath}`);
  }
}

main().catch((e) => {
  const reason =
    e?.errors?.[0]?.reason ||
    e?.response?.data?.error?.errors?.[0]?.reason ||
    e?.message ||
    e;
  if (String(reason).toLowerCase().includes("quota")) {
    console.error(
      "❗ Quota exceeded on all keys. limit을 줄이거나 USE_VIDEO_RANK=false 유지, 또는 키를 추가하세요."
    );
  } else {
    console.error("Error:", e?.response?.data || e);
  }
});
