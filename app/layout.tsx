import type { Metadata } from "next";
import { Schibsted_Grotesk, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const grotesk = Schibsted_Grotesk({
  variable: "--font-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://morningpick.ai"),
  title: "Morningpick — your AI research analyst",
  description:
    "One institutional-grade investment research note in your inbox every morning — screened across global exchanges, fact-checked against live market data, personalized to your investment philosophy.",
  openGraph: {
    title: "Morningpick — your AI research analyst",
    description:
      "One institutional-grade investment research note every morning. Screened globally, fact-checked, personalized. Reply to refine it.",
    url: "https://morningpick.ai",
    siteName: "Morningpick",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${grotesk.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
