"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Search } from "lucide-react";
import type { CommentWithReplies } from "@/hooks/use-comments";
import type { ExportFormat } from "@/lib/export-comments";
import type {
  CommentView,
  CommentVisibility,
  FilterState,
  SortMode,
} from "./comment-panel";

// Matches the rest of the phone review More menu.
const ITEM_CLASS =
  "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-text-secondary outline-none transition-colors hover:bg-bg-hover hover:text-text-primary data-[highlighted]:bg-bg-hover";
const SUB_TRIGGER_CLASS =
  "flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-sm text-text-secondary outline-none transition-colors hover:bg-bg-hover hover:text-text-primary data-[highlighted]:bg-bg-hover";
const SUB_CONTENT_CLASS =
  "z-[101] min-w-[180px] rounded-xl border border-border bg-bg-elevated p-1 shadow-xl";
const CHOICE_CLASS =
  "flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-sm text-text-secondary outline-none transition-colors hover:bg-bg-hover hover:text-text-primary data-[highlighted]:bg-bg-hover data-[state=checked]:text-text-primary";

const VISIBILITY_OPTIONS: { id: CommentVisibility; label: string }[] = [
  { id: "all", label: "All comments" },
  { id: "public", label: "Public comments" },
  { id: "internal", label: "Internal comments" },
];

const SORT_OPTIONS: { id: SortMode; label: string }[] = [
  { id: "timecode", label: "Timecode (Default)" },
  { id: "oldest", label: "Oldest" },
  { id: "newest", label: "Newest" },
  { id: "commenter", label: "Commenter" },
  { id: "completed", label: "Completed" },
];

const FILTER_OPTIONS: { key: keyof FilterState; label: string }[] = [
  { key: "annotations", label: "Annotations" },
  { key: "attachments", label: "Attachments" },
  { key: "completed", label: "Completed" },
  { key: "incomplete", label: "Incomplete" },
  { key: "unread", label: "Unread" },
  { key: "mentionsReactions", label: "Mentions and reactions" },
];

const VIDEO_EXPORTS: { format: ExportFormat; label: string }[] = [
  { format: "edl", label: "DaVinci Resolve (EDL)" },
  { format: "fcpxml", label: "Final Cut Pro (FCPXML)" },
  { format: "premiere_xml", label: "Premiere Pro (XML)" },
];

/**
 * The comment list's toolbar controls, as items for the phone review header's
 * More menu. On phones the inline toolbar is hidden, so this is where Show,
 * Sort, Filter, Search and Download live. Render inside a DropdownMenu.Content.
 */
export function MobileCommentMenuItems({
  view,
  comments,
  assetType,
  onSearch,
  showDownload = true,
}: {
  view: CommentView;
  /** Only what the Show counts need, so any comment shape fits. */
  comments: Pick<CommentWithReplies, "parent_id" | "visibility">[];
  assetType: string;
  /** Off where export can't work, e.g. a share-link guest with no account. */
  showDownload?: boolean;
  /** Lets the host menu keep focus on the search field when it closes. */
  onSearch?: () => void;
}) {
  const topLevel = comments.filter((comment) => comment.parent_id === null);
  const counts: Record<CommentVisibility, number> = {
    all: topLevel.length,
    public: topLevel.filter((comment) => comment.visibility !== "internal")
      .length,
    internal: topLevel.filter((comment) => comment.visibility === "internal")
      .length,
  };
  const activeFilterCount = Object.values(view.filters).filter(Boolean).length;
  const visibilityLabel =
    VISIBILITY_OPTIONS.find((option) => option.id === view.visibility)?.label ??
    "All comments";
  const sortLabel =
    SORT_OPTIONS.find((option) => option.id === view.sortMode)?.label.replace(
      " (Default)",
      "",
    ) ?? "Timecode";

  return (
    <>
      <DropdownMenu.Separator className="my-1 h-px bg-border" />
      <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
        Comments
      </DropdownMenu.Label>

      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className={SUB_TRIGGER_CLASS}>
          <span className="truncate">Show: {visibilityLabel}</span>
          <ChevronRight className="h-4 w-4 shrink-0" />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent className={SUB_CONTENT_CLASS}>
            <DropdownMenu.RadioGroup
              value={view.visibility}
              onValueChange={(value) =>
                view.setVisibility(value as CommentVisibility)
              }
            >
              {VISIBILITY_OPTIONS.map((option) => (
                <DropdownMenu.RadioItem
                  key={option.id}
                  value={option.id}
                  className={CHOICE_CLASS}
                >
                  {option.label}
                  <span className="flex items-center gap-2">
                    <span className="text-[12px] tabular-nums text-text-tertiary">
                      {counts[option.id]}
                    </span>
                    <DropdownMenu.ItemIndicator>
                      <Check className="h-4 w-4 text-accent" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>

      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className={SUB_TRIGGER_CLASS}>
          <span className="truncate">Sort: {sortLabel}</span>
          <ChevronRight className="h-4 w-4 shrink-0" />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent className={SUB_CONTENT_CLASS}>
            <DropdownMenu.RadioGroup
              value={view.sortMode}
              onValueChange={(value) => view.setSortMode(value as SortMode)}
            >
              {SORT_OPTIONS.map((option) => (
                <DropdownMenu.RadioItem
                  key={option.id}
                  value={option.id}
                  className={CHOICE_CLASS}
                >
                  {option.label}
                  <DropdownMenu.ItemIndicator>
                    <Check className="h-4 w-4 text-accent" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>

      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className={SUB_TRIGGER_CLASS}>
          <span className="truncate">
            Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0" />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent className={SUB_CONTENT_CLASS}>
            {FILTER_OPTIONS.map((option) => (
              <DropdownMenu.CheckboxItem
                key={option.key}
                checked={view.filters[option.key]}
                onCheckedChange={() => view.toggleFilter(option.key)}
                // Keep the menu open so several filters can be set in one go.
                onSelect={(event) => event.preventDefault()}
                className={CHOICE_CLASS}
              >
                {option.label}
                <DropdownMenu.ItemIndicator>
                  <Check className="h-4 w-4 text-accent" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.CheckboxItem>
            ))}
            {activeFilterCount > 0 && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item
                  onSelect={view.clearFilters}
                  className={ITEM_CLASS}
                >
                  Clear filters
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>

      <DropdownMenu.Item
        onSelect={() => {
          // Already open: nothing re-focuses the field, so let the menu hand
          // focus back to its trigger as usual.
          if (!view.searchOpen) onSearch?.();
          view.setSearchOpen(true);
        }}
        className={ITEM_CLASS}
      >
        <Search className="h-4 w-4" />
        Search comments
      </DropdownMenu.Item>

      {showDownload && (
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger className={SUB_TRIGGER_CLASS}>
            <span className="truncate">Download comments</span>
            <ChevronRight className="h-4 w-4 shrink-0" />
          </DropdownMenu.SubTrigger>
          <DropdownMenu.Portal>
            <DropdownMenu.SubContent className={SUB_CONTENT_CLASS}>
              {assetType === "video" &&
                VIDEO_EXPORTS.map((option) => (
                  <DropdownMenu.Item
                    key={option.format}
                    onSelect={() => void view.exportAs(option.format)}
                    className={ITEM_CLASS}
                  >
                    {option.label}
                  </DropdownMenu.Item>
                ))}
              <DropdownMenu.Item
                onSelect={() => void view.exportAs("csv")}
                className={ITEM_CLASS}
              >
                CSV
              </DropdownMenu.Item>
            </DropdownMenu.SubContent>
          </DropdownMenu.Portal>
        </DropdownMenu.Sub>
      )}
    </>
  );
}
