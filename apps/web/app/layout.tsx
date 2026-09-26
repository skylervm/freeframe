import type { Metadata, Viewport } from "next";
import { DM_Sans } from "next/font/google";
import { ToastProvider } from "@/components/shared/toast";
import { ThemeInitializer } from "@/components/shared/theme-initializer";
import "./globals.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const dmSans = DM_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
  preload: true,
});

export const metadata: Metadata = {
  title: "FreeFrame",
  description: "Collaborative media review and approval platform",
  // Generated from the workspace logo; the api falls back to /icon-default.png.
  icons: {
    icon: `${API_URL}/workspace/branding/icon.png`,
    apple: `${API_URL}/workspace/branding/icon.png`,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0A0A0B",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Inline script to apply theme BEFORE paint — prevents flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var d=JSON.parse(localStorage.getItem('ff-theme')||'{}');var t=d.state&&d.state.theme||'dark';if(t==='system'){t=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','dark')}})()`,
          }}
        />
      </head>
      <body className={`${dmSans.variable} font-sans antialiased`}>
        <ThemeInitializer />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
