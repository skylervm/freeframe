"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useUploadStore } from "@/stores/upload-store";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { CommandPalette } from "@/components/layout/command-palette";
import { UploadsPanel } from "@/components/layout/uploads-panel";
import { UploadSSEBridge } from "@/components/layout/upload-sse-bridge";
import { MobileNavigationProvider } from "@/components/layout/mobile-navigation-context";
import { cn } from "@/lib/utils";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = React.useState(false);
  const [isDesktopViewport, setIsDesktopViewport] = React.useState(false);
  const mobileNavigationTriggerRef = React.useRef<HTMLElement | null>(null);
  const backgroundContentRef = React.useRef<HTMLDivElement>(null);
  const [commandOpen, setCommandOpen] = React.useState(false);
  const { fetchUser } = useAuthStore();
  const { fetchHistory } = useUploadStore();

  // Hide header on asset viewer pages — the viewer has its own top bar
  const isAssetViewer = /\/projects\/[^/]+\/assets\/[^/]+/.test(pathname);

  React.useEffect(() => {
    fetchUser();
    fetchHistory();
  }, [fetchUser, fetchHistory]);

  // Global keyboard shortcut for command palette
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const closeMobileNavigation = React.useCallback((restoreFocus = true) => {
    setMobileSidebarOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => mobileNavigationTriggerRef.current?.focus());
    }
  }, []);

  const toggleMobileNavigation = React.useCallback((trigger?: HTMLElement) => {
    if (mobileSidebarOpen) {
      closeMobileNavigation();
      return;
    }
    if (trigger) mobileNavigationTriggerRef.current = trigger;
    setMobileSidebarOpen(true);
  }, [closeMobileNavigation, mobileSidebarOpen]);

  // A drawer is a phone-only surface. If a resize or rotation crosses into the
  // desktop layout, close it before the fixed 52px rail can inherit its expanded
  // contents. The user's desktop collapsed state remains untouched.
  React.useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeAtDesktopWidth = () => {
      setIsDesktopViewport(desktop.matches);
      if (desktop.matches) setMobileSidebarOpen(false);
    };
    closeAtDesktopWidth();
    desktop.addEventListener("change", closeAtDesktopWidth);
    return () => desktop.removeEventListener("change", closeAtDesktopWidth);
  }, []);

  const mobileDrawerOpen = mobileSidebarOpen && !isDesktopViewport;

  React.useEffect(() => {
    const background = backgroundContentRef.current;
    if (!background) return;
    background.toggleAttribute("inert", mobileDrawerOpen);
    background.setAttribute("aria-hidden", String(mobileDrawerOpen));
  }, [mobileDrawerOpen]);

  return (
    <MobileNavigationProvider isOpen={mobileDrawerOpen} onToggle={toggleMobileNavigation}>
      <div className="flex h-screen overflow-hidden bg-bg-primary">
        <Sidebar
          collapsed={sidebarCollapsed}
          mobileOpen={mobileDrawerOpen}
          onMobileClose={closeMobileNavigation}
          onToggle={() => setSidebarCollapsed((c) => !c)}
        />

        <div ref={backgroundContentRef} className="contents">
          {/* Main content area */}
          <main
            className={cn(
              "flex flex-1 flex-col overflow-hidden transition-[margin] duration-200 ease-spring",
              sidebarCollapsed ? "ml-0 md:ml-[52px]" : "ml-0 md:ml-[220px]",
            )}
          >
            {!isAssetViewer && <Header onSearchOpen={() => setCommandOpen(true)} />}

            <div className="relative flex-1 overflow-y-auto">{children}</div>
          </main>

          <UploadsPanel />
          <UploadSSEBridge />
          <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
        </div>
      </div>
    </MobileNavigationProvider>
  );
}
