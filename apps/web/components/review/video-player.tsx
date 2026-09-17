"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
  ChevronUp,
  Check,
  MoreHorizontal,
  Repeat,
} from "lucide-react";
import { cn, formatTime, formatTimecode, formatFrames } from "@/lib/utils";
import { renderedMediaBox } from "@/lib/media-frame";
import { api } from "@/lib/api";
import { useReviewStore, type TimeFormat } from "@/stores/review-store";
import { useVideoPlayer } from "@/hooks/use-video-player";
import { useReview } from "./review-provider";
import { ProgressBar } from "./progress-bar";
import type { Comment } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StreamUrlResponse {
  url: string;
}

interface VideoPlayerProps {
  assetId: string;
  comments?: Comment[];
  overlay?: React.ReactNode;
  className?: string;
  /** Pre-fetched stream URL (for share mode — skips authenticated API call) */
  initialStreamUrl?: string | null;
  /**
   * Phone portrait: size the video area to its natural 16:9 box instead of
   * filling the column, so there is no letterbox padding above and below.
   * Ignored in fullscreen and on md+, and overridden in phone landscape by
   * the `.review-workspace` orientation rule in globals.css.
   */
  compact?: boolean;
}

// ─── Video frame constraint ──────────────────────────────────────────────────

/**
 * Wraps children so they are positioned exactly over the visible video frame,
 * excluding the black letterbox bars created by object-contain.
 *
 * Exported for the compare overlay: annotations are AUTHORED inside this
 * constraint (video-frame coordinates), so any viewer that renders them must
 * mount the overlay in the same space.
 */
export function VideoFrameConstraint({
  videoRef,
  children,
}: {
  videoRef: React.RefObject<HTMLVideoElement>;
  children: React.ReactNode;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const calc = () => {
      // Measured from the element's own box, exactly like the image constraint.
      // The main player's <video> is `w-full h-full object-contain`, so its box
      // IS the container and this reduces to fitting against the container. The
      // compare panes use `max-h-full max-w-full`, where the element only ever
      // shrinks and so already hugs the picture — deriving the fit from the
      // container there would upscale the box and misplace every annotation.
      const box = renderedMediaBox({
        naturalWidth: video.videoWidth,
        naturalHeight: video.videoHeight,
        elementWidth: video.offsetWidth,
        elementHeight: video.offsetHeight,
        offsetLeft: video.offsetLeft,
        offsetTop: video.offsetTop,
      });

      if (!box) {
        // Not laid out yet — fill the container and recompute on the next
        // loadedmetadata/resize.
        setStyle({ position: "absolute", inset: 0 });
        return;
      }

      setStyle({
        position: "absolute",
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      });
    };

    calc();
    video.addEventListener("loadedmetadata", calc);
    video.addEventListener("resize", calc);

    // Observe both: under `max-*` a container resize only RECENTRES the element,
    // moving offsetLeft/offsetTop without changing its own box, and
    // ResizeObserver does not fire on a position-only change.
    const ro = new ResizeObserver(calc);
    ro.observe(video);
    if (video.parentElement) ro.observe(video.parentElement);

    return () => {
      video.removeEventListener("loadedmetadata", calc);
      video.removeEventListener("resize", calc);
      ro.disconnect();
    };
  }, [videoRef]);

  return (
    <div ref={wrapperRef} style={style} className="overflow-hidden">
      {children}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export function VideoPlayer({
  assetId,
  comments = [],
  overlay,
  className,
  initialStreamUrl,
  compact = false,
}: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [loop, setLoop] = useState(false);
  const [transportMoreOpen, setTransportMoreOpen] = useState(false);

  const { isDrawingMode, timeFormat, setTimeFormat, setPlayheadTime, currentVersion } =
    useReviewStore();
  const { registerPauseHandler } = useReview();
  const [timeFormatOpen, setTimeFormatOpen] = useState(false);
  const timeFormatRef = useRef<HTMLDivElement>(null);

  // Close time format dropdown on outside click
  useEffect(() => {
    if (!timeFormatOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        timeFormatRef.current &&
        !timeFormatRef.current.contains(e.target as Node)
      )
        setTimeFormatOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [timeFormatOpen]);

  function displayTime(seconds: number): string {
    switch (timeFormat) {
      case "frames":
        return formatFrames(seconds);
      case "standard":
        return formatTime(seconds);
      case "timecode":
        return formatTimecode(seconds);
      default:
        return formatTimecode(seconds);
    }
  }

  // Load the stream URL — reset immediately on asset OR version change so the old
  // video doesn't keep playing while the new URL is being fetched.
  const versionId = currentVersion?.id;
  useEffect(() => {
    // Guard against a superseded fetch: rapid version switching starts overlapping
    // requests, and without this a slower earlier response could land last and leave
    // the player on the wrong version's stream.
    let ignore = false;
    setStreamUrl(null);
    if (initialStreamUrl) {
      const resolved = initialStreamUrl.startsWith("/")
        ? `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}${initialStreamUrl}`
        : initialStreamUrl;
      setStreamUrl(resolved);
      return;
    }
    // Pin the stream to the selected version — without version_id the API falls
    // back to the latest version, so the switcher never actually changes the
    // playing stream (#66).
    const streamPath = versionId
      ? `/assets/${assetId}/stream?version_id=${versionId}`
      : `/assets/${assetId}/stream`;
    api
      .get<StreamUrlResponse>(streamPath)
      .then((data) => {
        if (ignore) return;
        // HLS proxy returns relative paths — prepend API URL
        const url = data.url.startsWith("/")
          ? `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}${data.url}`
          : data.url;
        setStreamUrl(url);
      })
      .catch(() => {
        /* stream URL errors handled by player error state */
      });
    return () => {
      ignore = true;
    };
  }, [assetId, initialStreamUrl, versionId]);

  const player = useVideoPlayer(streamUrl);

  const {
    videoRef,
    isPlaying,
    currentTime,
    duration,
    buffered,
    volume,
    isMuted,
    playbackRate,
    qualityLevels,
    currentQuality,
    isLoading,
    isFullscreen,
    error,
    pause,
    togglePlay,
    seek,
    setPlaybackRate,
    setQuality,
    setVolume,
    toggleMute,
    toggleFullscreen,
  } = player;

  // Register pause handler with review provider
  useEffect(() => {
    registerPauseHandler(pause);
  }, [registerPauseHandler, pause]);

  // Sync video currentTime to review store so comment input shows same timecode
  const lastSyncRef = useRef(0);
  useEffect(() => {
    const now = Date.now();
    if (now - lastSyncRef.current > 100) {
      setPlayheadTime(currentTime);
      lastSyncRef.current = now;
    }
  }, [currentTime, setPlayheadTime]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        isDrawingMode
      ) {
        return;
      }

      // FreeFrame assumes 24fps throughout (see formatTimecode / formatFrames in lib/utils).
      const frameStep = 1 / 24;

      switch (e.code) {
        case "Space":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seek(currentTime - (e.shiftKey ? (e.metaKey ? 5 : 1) : frameStep));
          break;
        case "ArrowRight":
          e.preventDefault();
          seek(currentTime + (e.shiftKey ? (e.metaKey ? 5 : 1) : frameStep));
          break;
        case "KeyJ":
          seek(currentTime - 10);
          break;
        case "KeyK":
          togglePlay();
          break;
        case "KeyL":
          seek(currentTime + 10);
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePlay, seek, currentTime, isDrawingMode]);

  const handleContainerClick = useCallback(() => {
    if (!isDrawingMode) {
      togglePlay();
    }
  }, [togglePlay, isDrawingMode]);

  const handleFullscreen = useCallback(() => {
    if (containerRef.current) {
      toggleFullscreen(containerRef.current);
    }
  }, [toggleFullscreen]);

  const handleSpeedCycle = useCallback(() => {
    const idx = SPEED_OPTIONS.indexOf(
      playbackRate as (typeof SPEED_OPTIONS)[number],
    );
    const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
    setPlaybackRate(next);
  }, [playbackRate, setPlaybackRate]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "review-player flex flex-col w-full",
        compact && !isFullscreen ? "h-auto md:h-full" : "h-full",
        isFullscreen && "fixed inset-0 z-50",
        className,
      )}
    >
      {/* Video area — object-contain preserves aspect ratio. Fills available
          space by default; in compact (phone portrait) mode it takes its
          natural 16:9 height so no letterbox bars are added. */}
      <div
        className={cn(
          "review-video-area relative bg-black overflow-hidden cursor-pointer",
          compact && !isFullscreen
            ? "aspect-video w-full shrink-0 md:aspect-auto md:flex-1 md:min-h-0"
            : "flex-1 min-h-0",
        )}
        onClick={handleContainerClick}
      >
        <video
          ref={videoRef}
          className={cn(
            "absolute inset-0 w-full h-full object-contain",
            isDrawingMode ? "pointer-events-none" : "",
          )}
          playsInline
          preload="metadata"
        />

        {/* Loading spinner */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-10 h-10 border-4 border-white/20 border-t-white rounded-full animate-spin" />
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}

        {/* Overlay slot (annotation canvas / overlay) — constrained to video frame */}
        {overlay && (
          <VideoFrameConstraint videoRef={videoRef}>
            {overlay}
          </VideoFrameConstraint>
        )}
      </div>

      {/* Progress bar */}
      <div className="shrink-0 bg-bg-primary">
        <ProgressBar
          currentTime={currentTime}
          duration={duration}
          buffered={buffered}
          comments={comments}
          streamUrl={streamUrl}
          onSeek={seek}
        />
      </div>

      {/* Bottom transport bar (matches audio player style) */}
      <div className="flex h-12 items-center justify-between border-t border-border bg-bg-secondary/80 px-2 shrink-0 md:px-4">
        {/* Left: Play, Loop, Speed, Volume */}
        <div className="flex shrink-0 items-center gap-1 md:gap-2">
          <button
            onClick={togglePlay}
            className="flex h-7 w-7 items-center justify-center rounded text-text-primary hover:bg-bg-hover transition-colors"
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </button>

          <button
            onClick={() => setLoop((p) => !p)}
            className={cn(
              "hidden h-7 w-7 items-center justify-center rounded transition-colors lg:flex",
              loop
                ? "text-accent bg-accent/10"
                : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover",
            )}
            aria-label="Loop"
          >
            <Repeat className="h-4 w-4" />
          </button>

          <button
            onClick={handleSpeedCycle}
            className="hidden h-7 items-center justify-center rounded px-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors tabular-nums lg:flex"
            aria-label="Playback speed"
          >
            {playbackRate}x
          </button>

          <button
            onClick={toggleMute}
            className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
            aria-label={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted || volume === 0 ? (
              <VolumeX className="h-4 w-4" />
            ) : (
              <Volume2 className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* Center: Timecode display with format picker */}
        <div className="relative flex min-w-0 flex-1 justify-center px-1 lg:flex-none lg:px-0" ref={timeFormatRef}>
          <button
            onClick={() => setTimeFormatOpen((p) => !p)}
            aria-label="Time format"
            className="flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md bg-bg-tertiary px-3 py-1 transition-colors hover:bg-bg-hover"
          >
            <span className="min-w-0 max-w-[9rem] flex-1 truncate font-mono text-sm text-text-primary tabular-nums tracking-wide lg:max-w-none lg:flex-none">
              {timeFormat === "timecode" ? (
                displayTime(currentTime)
              ) : (
                <>
                  {displayTime(currentTime)}{" "}
                  <span className="text-text-tertiary">/</span>{" "}
                  {displayTime(duration)}
                </>
              )}
            </span>
            <ChevronUp
              className={cn(
                "h-3 w-3 shrink-0 text-text-tertiary transition-transform",
                timeFormatOpen && "rotate-180",
              )}
            />
          </button>
          {timeFormatOpen && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-48 rounded-xl border border-white/10 bg-[#2a2a30] shadow-2xl py-1.5 animate-in fade-in zoom-in-95 duration-100">
              <div className="px-3 py-2 text-[11px] text-text-tertiary uppercase tracking-wider font-medium">
                Time Format
              </div>
              {(
                [
                  { id: "frames" as TimeFormat, label: "Frames" },
                  { id: "standard" as TimeFormat, label: "Standard" },
                  { id: "timecode" as TimeFormat, label: "Timecode" },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  className={cn(
                    "flex w-full items-center justify-between px-3 py-2 text-[13px] transition-colors",
                    timeFormat === item.id
                      ? "text-text-primary"
                      : "text-text-secondary hover:bg-white/5",
                  )}
                  onClick={() => {
                    setTimeFormat(item.id);
                    setTimeFormatOpen(false);
                  }}
                >
                  {item.label}
                  {timeFormat === item.id && (
                    <Check className="h-4 w-4 text-accent" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: Quality, Fullscreen */}
        <div className="flex shrink-0 items-center gap-1 md:gap-2">
          {/* Quality selector */}
          {qualityLevels.length > 0 && (
            <select
              value={currentQuality}
              onChange={(e) => setQuality(parseInt(e.target.value, 10))}
              className="hidden shrink-0 cursor-pointer rounded border border-border bg-transparent px-1.5 py-1 text-xs text-text-secondary transition-colors hover:text-text-primary lg:block"
              aria-label="Quality"
            >
              <option value={-1} className="bg-bg-secondary">
                Auto
              </option>
              {qualityLevels.map((level) => (
                <option
                  key={level.index}
                  value={level.index}
                  className="bg-bg-secondary"
                >
                  {level.label}
                </option>
              ))}
            </select>
          )}

          <DropdownMenu.Root open={transportMoreOpen} onOpenChange={setTransportMoreOpen}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary lg:hidden"
                aria-label="More playback controls"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                side="top"
                sideOffset={8}
                className="z-50 w-40 rounded-lg border border-border bg-bg-elevated p-1 shadow-xl lg:hidden"
              >
                <DropdownMenu.Item
                  onSelect={() => setLoop((value) => !value)}
                  className={cn(
                    'flex cursor-pointer items-center justify-between rounded-md px-2.5 py-2 text-sm outline-none transition-colors hover:bg-bg-hover data-[highlighted]:bg-bg-hover',
                    loop ? 'text-accent' : 'text-text-secondary',
                  )}
                >
                  Loop
                  {loop && <Check className="h-3.5 w-3.5" />}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={handleSpeedCycle}
                  className="flex cursor-pointer items-center justify-between rounded-md px-2.5 py-2 text-sm text-text-secondary outline-none transition-colors hover:bg-bg-hover data-[highlighted]:bg-bg-hover"
                >
                  Playback speed
                  <span className="tabular-nums">{playbackRate}x</span>
                </DropdownMenu.Item>
                {qualityLevels.length > 0 && (
                  <DropdownMenu.Sub>
                    <DropdownMenu.SubTrigger className="flex cursor-pointer items-center justify-between rounded-md px-2.5 py-2 text-sm text-text-secondary outline-none transition-colors hover:bg-bg-hover data-[highlighted]:bg-bg-hover">
                      Quality
                      <span className="text-xs">{currentQuality === -1 ? 'Auto' : qualityLevels.find((level) => level.index === currentQuality)?.label}</span>
                    </DropdownMenu.SubTrigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.SubContent className="z-50 min-w-[100px] rounded-lg border border-border bg-bg-elevated p-1 shadow-xl">
                        <DropdownMenu.RadioGroup value={String(currentQuality)} onValueChange={(value) => setQuality(parseInt(value, 10))}>
                          <DropdownMenu.RadioItem value="-1" className="flex cursor-pointer items-center justify-between rounded-md px-2.5 py-2 text-sm text-text-secondary outline-none hover:bg-bg-hover data-[highlighted]:bg-bg-hover">Auto</DropdownMenu.RadioItem>
                          {qualityLevels.map((level) => (
                            <DropdownMenu.RadioItem key={level.index} value={String(level.index)} className="flex cursor-pointer items-center justify-between rounded-md px-2.5 py-2 text-sm text-text-secondary outline-none hover:bg-bg-hover data-[highlighted]:bg-bg-hover">{level.label}</DropdownMenu.RadioItem>
                          ))}
                        </DropdownMenu.RadioGroup>
                      </DropdownMenu.SubContent>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Sub>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          {/* Fullscreen */}
          <button
            onClick={handleFullscreen}
            className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFullscreen ? (
              <Minimize className="h-4 w-4" />
            ) : (
              <Maximize className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
