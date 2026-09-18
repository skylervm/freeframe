"use client";

import * as React from "react";
import { useReviewStore } from "@/stores/review-store";
import {
  exportComments,
  FpsRequiredError,
  type ExportFormat,
} from "@/lib/export-comments";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CommentVisibility = "all" | "public" | "internal";
export type SortMode = "timecode" | "oldest" | "newest" | "commenter" | "completed";

export interface FilterState {
  annotations: boolean;
  attachments: boolean;
  completed: boolean;
  incomplete: boolean;
  unread: boolean;
  mentionsReactions: boolean;
}

const EMPTY_FILTERS: FilterState = {
  annotations: false,
  attachments: false,
  completed: false,
  incomplete: false,
  unread: false,
  mentionsReactions: false,
};

// ─── View state ───────────────────────────────────────────────────────────────

/**
 * What the comment list shows and how it is exported. Lives in a hook so the
 * review page can own one copy and hand it to both the desktop toolbar and the
 * phone More menu; screens that do not pass a view keep a private copy.
 */
export function useCommentView(exportVersionId?: string) {
  const currentAsset = useReviewStore((s) => s.currentAsset);
  const currentVersion = useReviewStore((s) => s.currentVersion);
  const [visibility, setVisibility] = React.useState<CommentVisibility>("all");
  const [sortMode, setSortMode] = React.useState<SortMode>("timecode");
  const [filters, setFilters] = React.useState<FilterState>(EMPTY_FILTERS);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [fpsPromptFormat, setFpsPromptFormat] =
    React.useState<ExportFormat | null>(null);
  // Bumped by reset(), so an export that fails after the view was reset
  // cannot raise a frame-rate prompt the next time comments are shown.
  const resetGenerationRef = React.useRef(0);

  const toggleFilter = React.useCallback((key: keyof FilterState) => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);
  const clearFilters = React.useCallback(() => setFilters(EMPTY_FILTERS), []);
  const reset = React.useCallback(() => {
    resetGenerationRef.current += 1;
    setVisibility("all");
    setSortMode("timecode");
    setFilters(EMPTY_FILTERS);
    setSearchOpen(false);
    setSearchQuery("");
    setFpsPromptFormat(null);
  }, []);

  const exportAs = React.useCallback(
    async (format: ExportFormat, fps?: number) => {
      const versionId = exportVersionId ?? currentVersion?.id;
      if (!currentAsset || !versionId) return;
      const generation = resetGenerationRef.current;
      try {
        await exportComments({
          assetId: currentAsset.id,
          versionId,
          format,
          fps,
        });
      } catch (err) {
        if (err instanceof FpsRequiredError) {
          if (resetGenerationRef.current === generation) {
            setFpsPromptFormat(format);
          }
        } else {
          console.error(err);
        }
      }
    },
    [currentAsset, currentVersion?.id, exportVersionId],
  );

  return {
    visibility,
    setVisibility,
    sortMode,
    setSortMode,
    filters,
    toggleFilter,
    clearFilters,
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    fpsPromptFormat,
    setFpsPromptFormat,
    exportAs,
    reset,
  };
}

export type CommentView = ReturnType<typeof useCommentView>;
