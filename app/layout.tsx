import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
  title: "ask3d",
  description: "Describe an object, get a 3D-printable model.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* Warm the HTTP cache for the 10.5MB compiler while the user types. */}
        <link rel="prefetch" href="/openscad/openscad.wasm" />
        <link rel="prefetch" href="/openscad/openscad.js" />
        {children}
      </body>
    </html>
  );
}
