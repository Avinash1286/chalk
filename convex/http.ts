import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

// Live HLS endpoint.
//
//   GET /hls/<jobId>.m3u8     → EVENT playlist, regenerated from the DB on
//                               every poll (gains one #EXTINF per uploaded
//                               segment; #EXT-X-ENDLIST once the render ends)
//   GET /hls/<jobId>/<n>.ts   → the nth MPEG-TS segment, streamed from
//                               storage (immutable → cached aggressively)
//
// Segments are immutable storage files uploaded exactly once by the worker —
// only the tiny playlist is dynamic. hls.js polls the playlist while the type
// is EVENT, so the player's timeline grows live as the worker renders.

const http = httpRouter();

const CORS = { "Access-Control-Allow-Origin": "*" };

function notFound(): Response {
  return new Response("not found", { status: 404, headers: CORS });
}

http.route({
  pathPrefix: "/hls/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const path = new URL(request.url).pathname;

    const playlist = path.match(/^\/hls\/([^/]+)\.m3u8$/);
    if (playlist) {
      const hls = await ctx.runQuery(internal.jobs.getHls, { jobId: playlist[1] });
      if (!hls || hls.segments.length === 0) return notFound();
      const target = Math.ceil(Math.max(...hls.segments.map((s) => s.duration), 1));
      const lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        `#EXT-X-TARGETDURATION:${target}`,
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:EVENT",
        ...hls.segments.flatMap((s, i) => [`#EXTINF:${s.duration.toFixed(3)},`, `/hls/${playlist[1]}/${i}.ts`]),
        ...(hls.complete ? ["#EXT-X-ENDLIST"] : []),
        "",
      ];
      return new Response(lines.join("\n"), {
        headers: {
          ...CORS,
          "Content-Type": "application/vnd.apple.mpegurl",
          // The playlist changes as segments land — never cache it.
          "Cache-Control": "no-store",
        },
      });
    }

    const segment = path.match(/^\/hls\/([^/]+)\/(\d+)\.ts$/);
    if (segment) {
      const hls = await ctx.runQuery(internal.jobs.getHls, { jobId: segment[1] });
      const seg = hls?.segments[Number(segment[2])];
      if (!seg) return notFound();
      const blob = await ctx.storage.get(seg.fileId);
      if (!blob) return notFound();
      return new Response(blob, {
        headers: {
          ...CORS,
          "Content-Type": "video/mp2t",
          // Segments are immutable — let the browser cache them outright.
          "Cache-Control": "public, max-age=86400, immutable",
        },
      });
    }

    return notFound();
  }),
});

export default http;
