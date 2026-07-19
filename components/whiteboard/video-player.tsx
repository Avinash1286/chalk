"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The job's video surface, with live streaming:
 *   • If a live HLS stream exists when the player first attaches, it stays on
 *     HLS — playback starts while the video is still rendering. Completion just
 *     appends #EXT-X-ENDLIST, turning the playlist into a finished VOD that
 *     hls.js plays straight through; the final MP4 is intentionally ignored.
 *   • If there's no live stream at attach time (a fresh load of a completed
 *     job), it plays the MP4.
 * The source is LOCKED on first availability — later prop changes never reload
 * an in-progress watch.
 */
export function VideoPlayer({ hlsUrl, videoUrl }: { hlsUrl: string | null; videoUrl: string | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<{ destroy: () => void } | null>(null);
  const [src, setSrc] = useState<{ url: string; kind: "hls" | "mp4" } | null>(null);

  useEffect(() => {
    if (src) return; // already committed — never swap
    if (hlsUrl) setSrc({ url: hlsUrl, kind: "hls" });
    else if (videoUrl) setSrc({ url: videoUrl, kind: "mp4" });
  }, [src, hlsUrl, videoUrl]);

  useEffect(() => {
    const video = ref.current;
    if (!video || !src) return;
    let cancelled = false;
    if (src.kind === "hls") {
      // ALWAYS prefer hls.js when MSE is available: desktop Chrome answers
      // "maybe" to canPlayType('application/vnd.apple.mpegurl') but its native
      // demuxer then fails to parse — a black player. Native HLS is only the
      // fallback for MSE-less browsers (iOS Safari). hls.js is browser-only —
      // lazy-load so SSR never touches it.
      void import("hls.js").then(({ default: Hls }) => {
        if (cancelled) return;
        if (Hls.isSupported()) {
          const hls = new Hls({ startPosition: 0 });
          hlsRef.current = hls;
          hls.loadSource(src.url);
          hls.attachMedia(video);
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = src.url;
        } else {
          console.warn("This browser supports neither MediaSource nor native HLS — live preview unavailable.");
        }
      });
    } else {
      video.src = src.url;
    }
    video.play().catch(() => {
      /* autoplay policy — controls remain */
    });
    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [src]);

  if (!src) return null;
  return <video ref={ref} className="aspect-video w-full" controls playsInline />;
}
