import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "IQAIR//OS — Trading Operating System",
  description:
    "A trading OS built around the iqair IQ Option library: full technical analysis, Markov chains, Monte Carlo, strategy backtesting, risk management and an AI copilot.",
  keywords: ["trading", "iq option", "iqair", "markov", "monte carlo", "technical analysis", "backtesting"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: "#0d1420",
              border: "1px solid #1c2739",
              color: "#dbe4f0",
              fontFamily: "var(--font-geist-mono), monospace",
              fontSize: "12px",
            },
          }}
        />
      </body>
    </html>
  );
}
